function ciState(checks, statuses) {
  const latest = new Map();
  for (const c of checks) {
    const k = `${c.app?.id}:${c.name}`;
    if (!latest.has(k) || Number(c.id) > Number(latest.get(k).id)) latest.set(k, c);
  }
  const contexts = new Map();
  for (const s of statuses) if (!contexts.has(s.context)) contexts.set(s.context, s);
  const failures = [...latest.values()].filter(c => c.status === 'completed' && ['failure','timed_out','cancelled','action_required','startup_failure','stale'].includes(c.conclusion));
  const badStatuses = [...contexts.values()].filter(s => ['failure','error'].includes(s.state));
  const pending = [...latest.values()].some(c => c.status !== 'completed' || !['success','neutral','skipped','failure','timed_out','cancelled','action_required','startup_failure','stale'].includes(c.conclusion)) || [...contexts.values()].some(s => !['success','failure','error'].includes(s.state));
  const hasSuccess = [...latest.values()].some(c => c.conclusion === 'success') || [...contexts.values()].some(s => s.state === 'success');
  return { state: failures.length || badStatuses.length ? 'red' : pending || !hasSuccess ? 'pending' : 'green', failures, badStatuses };
}

class Manager {
  constructor({ config, github, state, save, notify }) {
    Object.assign(this, { config, gh: github, state, save, notify });
    this.locks = new Set();
  }
  record(repo) { return this.state.repositories[repo.name] ||= { prs: {}, lastMerge: null, outbox: [] }; }
  persist() { this.save(this.state); }
  event(repo, id, content) {
    const record = this.record(repo);
    if (!record.outbox.some(n => n.id === id)) record.outbox.push({ id, content, delivered: false });
    this.persist();
  }
  async flush(repo) {
    for (const item of this.record(repo).outbox.filter(x => !x.delivered)) {
      await this.notify(item.content);
      item.delivered = true;
      this.persist();
    }
  }
  async snapshot(repo, number) {
    const pr = await this.gh.call(repo, `/pulls/${number}`);
    const checks = await this.gh.pages(repo, `/commits/${pr.head.sha}/check-runs?filter=latest`, 'check_runs');
    const statuses = await this.gh.pages(repo, `/commits/${pr.head.sha}/statuses`);
    return { pr, ci: ciState(checks, statuses), checks };
  }
  eligible(repo, pr) { return pr.state === 'open' && !pr.draft && pr.user.login === repo.renovateLogin && pr.head.repo?.full_name === repo.name; }
  prRecord(repo, pr) {
    const record = this.record(repo);
    return record.prs[`${pr.number}:${pr.head.sha}`] ||= { retries: {}, approved: false };
  }
  confirmApproval(repo, pr) {
    this.prRecord(repo, pr).approved = true;
    const id = `approved:${pr.number}`;
    const recorded = this.record(repo).outbox.some(item => item.id === id || item.id.startsWith(id + ':'));
    if (!recorded) this.event(repo, id, `✅ Approved ${repo.name} #${pr.number} — ${pr.title}\n${pr.html_url}\nAll observed CI checks passed. Commit: ${pr.head.sha}`);
    else this.persist();
  }
  async monitorPr(repo, number, dryRun) {
    const { pr, ci, checks } = await this.snapshot(repo, number);
    const result = { number, title: pr.title, sha: pr.head.sha, ci: ci.state, url: pr.html_url };
    if (!this.eligible(repo, pr)) return { ...result, action: 'skip' };
    const record = this.prRecord(repo, pr);
    if (ci.state === 'pending') return { ...result, action: 'wait' };
    if (ci.state === 'green') {
      const reviews = await this.gh.pages(repo, `/pulls/${number}/reviews`);
      const appReview = reviews.filter(r => r.user?.login === this.config.appSlug + '[bot]' && ['APPROVED','CHANGES_REQUESTED','DISMISSED'].includes(r.state)).at(-1);
      const appApproval = appReview?.state === 'APPROVED' && appReview.commit_id === pr.head.sha;
      if (appApproval) { if (!dryRun) this.confirmApproval(repo, pr); return { ...result, action: 'already-approved' }; }
      if (!dryRun) {
        record.approved = false; this.persist();
        const fresh = await this.gh.call(repo, `/pulls/${number}`);
        if (fresh.head.sha !== pr.head.sha || !this.eligible(repo, fresh)) return { ...result, action: 'commit-changed' };
        const pending = reviews.find(r => r.user?.login === this.config.appSlug + '[bot]' && r.state === 'PENDING' && r.commit_id === pr.head.sha);
        const review = await this.gh.call(repo, pending ? `/pulls/${number}/reviews/${pending.id}/events` : `/pulls/${number}/reviews`, 'POST', { event: 'APPROVE', ...(pending ? {} : { commit_id: pr.head.sha }), body: 'All observed CI checks passed. Approved by the Renovate automation.' });
        if (!review?.id || review.state !== 'APPROVED' || review.commit_id !== pr.head.sha || review.user?.login !== this.config.appSlug + '[bot]') throw new Error('GitHub did not confirm an APPROVED review for the inspected commit');
        const confirmed = await this.gh.pages(repo, `/pulls/${number}/reviews`);
        const latest = confirmed.filter(r => r.user?.login === this.config.appSlug + '[bot]' && ['APPROVED','CHANGES_REQUESTED','DISMISSED'].includes(r.state)).at(-1);
        if (latest?.id !== review.id || latest.state !== 'APPROVED' || latest.commit_id !== pr.head.sha) throw new Error('GitHub approval read-back failed for the inspected commit');
        this.confirmApproval(repo, pr);
      }
      return { ...result, action: dryRun ? 'would-approve' : 'approved' };
    }
    const runs = await this.gh.pages(repo, `/actions/runs?head_sha=${pr.head.sha}`, 'workflow_runs');
    // Only retry runs associated with this PR or its exact source branch and commit.
    const newest = new Map();
    for (const r of runs.filter(r => r.head_sha === pr.head.sha && (r.pull_requests?.some(p => p.number === number) || r.head_branch === pr.head.ref))) {
      const key = `${r.workflow_id}:${r.event}`;
      if (!newest.has(key) || r.id > newest.get(key).id) newest.set(key, r);
    }
    const relevant = [...newest.values()];
    const failed = relevant.filter(r => r.status === 'completed' && ['failure','timed_out','cancelled','action_required','startup_failure','stale'].includes(r.conclusion));
    const actions = [];
    for (const run of failed) {
      const saved = record.retries[run.id];
      if (saved) {
        if ((run.run_attempt || 1) > saved.initialAttempt && !saved.notified) {
          actions.push(`retry-failed:${run.id}`);
          if (!dryRun) {
            this.event(repo, `failed:${number}:${pr.head.sha}:${run.id}`, `❌ CI failed again: ${repo.name} #${number} — ${pr.title}\n${pr.html_url}\nWorkflow: ${run.name}\n${run.html_url}`);
            saved.notified = true; this.persist();
          }
        } else actions.push(`retry-already-requested:${run.id}`);
        continue;
      }
      const fresh = await this.gh.call(repo, `/pulls/${number}`);
      if (fresh.head.sha !== pr.head.sha || !this.eligible(repo, fresh)) return { ...result, action: 'commit-changed' };
      actions.push(`retry-failed-jobs:${run.id}`);
      if (!dryRun) {
        // Persist intent before requesting a retry. An ambiguous network failure never causes an automatic second retry.
        record.retries[run.id] = { initialAttempt: run.run_attempt || 1, requestedAt: new Date().toISOString(), notified: false };
        this.persist();
        try {
          await this.gh.call(repo, `/actions/runs/${run.id}/rerun-failed-jobs`, 'POST', {});
          record.retries[run.id].accepted = true; this.persist();
        } catch (error) { if (error?.yieldEffect) throw error;
          this.event(repo, `retry-error:${number}:${pr.head.sha}:${run.id}`, `⚠️ Could not confirm a CI retry for ${repo.name} #${number}. Please inspect the run; no second retry will be requested automatically.\n${run.html_url}\n${error.message}`);
        }
      }
    }
    const external = ci.failures.filter(c => c.app?.slug !== 'github-actions');
    if (external.length || ci.badStatuses.length || (!failed.length && !relevant.some(r => r.status !== 'completed'))) {
      actions.push('unretryable-check');
      if (!dryRun) this.event(repo, `unretryable:${number}:${pr.head.sha}`, `⚠️ ${repo.name} #${number} has failing CI that could not be mapped to a completed GitHub Actions run.\n${pr.html_url}\nChecks: ${[...external.map(c=>c.name), ...ci.badStatuses.map(s=>s.context)].join(', ') || 'See PR checks'}`);
    }
    return { ...result, action: dryRun ? 'would-handle-failures' : 'handled-failures', details: actions };
  }
  async cleanup(repo) {
    const record = this.record(repo);
    const pending = record.pendingMerge;
    if (!pending) return;
    const pr = await this.gh.call(repo, `/pulls/${pending.number}`);
    if (!pr.merged) {
      if (pending.uncertain) throw new Error(`Merge outcome for #${pending.number} is still uncertain; inspect before continuing`);
      delete record.pendingMerge; this.persist(); return;
    }
    record.lastMerge = pr.merged_at;
    let deleted = false;
    let cleanupFailed = false;
    // Never delete a default branch, fork branch, or a branch whose tip changed since merging.
    const metadata = await this.gh.call(repo, '');
    if (pending.branch !== metadata.default_branch && pr.head.repo?.full_name === repo.name) {
      try {
        const ref = await this.gh.call(repo, `/git/ref/heads/${encodeURIComponent(pending.branch)}`);
        if (ref.object.sha === pending.sha) { await this.gh.call(repo, `/git/refs/heads/${encodeURIComponent(pending.branch)}`, 'DELETE'); deleted = true; }
      } catch (error) { if (error?.yieldEffect) throw error; if (error.status === 404) deleted = true; else { pending.cleanupError = error.message; cleanupFailed = true; } }
    }
    this.event(repo, `merged:${pending.number}:${pending.sha}`, `✅ Merged ${repo.name} #${pr.number} — ${pr.title}\n${pr.html_url}\nMethod: ${repo.mergeMethod}. Branch ${deleted ? 'deleted' : 'retained; deletion needs attention'}. Schedule: :15 and :45 each hour.`);
    if (cleanupFailed) {
      this.persist();
      await this.flush(repo);
      throw new Error('Merge succeeded, but branch deletion failed; cleanup will be retried before another merge');
    }
    delete record.pendingMerge; this.persist();
  }
  async merge(repo, dryRun) {
    const record = this.record(repo);
    if (!dryRun) await this.cleanup(repo);
    const prs = await this.gh.pages(repo, '/pulls?state=open&sort=created&direction=asc');
    for (const item of prs.filter(p => this.eligible(repo, p))) {
      const { pr, ci } = await this.snapshot(repo, item.number);
      if (!this.eligible(repo, pr) || ci.state !== 'green' || !pr.mergeable || pr.mergeable_state !== 'clean') continue;
      const reviews = await this.gh.pages(repo, `/pulls/${pr.number}/reviews`);
      const latestReviews = new Map();
      for (const r of reviews) if (['APPROVED','CHANGES_REQUESTED','DISMISSED'].includes(r.state)) latestReviews.set(r.user.login, r);
      if ([...latestReviews.values()].some(r => r.state === 'CHANGES_REQUESTED')) continue;
      const appReview = latestReviews.get(this.config.appSlug+'[bot]');
      if (appReview?.state !== 'APPROVED' || appReview.commit_id !== pr.head.sha) continue;
      if (dryRun) return { action: 'would-merge', number: pr.number, sha: pr.head.sha, method: repo.mergeMethod };
      const fresh = await this.snapshot(repo, pr.number);
      if (fresh.pr.head.sha !== pr.head.sha || fresh.ci.state !== 'green' || fresh.pr.mergeable_state !== 'clean') continue;
      record.pendingMerge = { number: pr.number, sha: pr.head.sha, branch: pr.head.ref, uncertain: true };
      this.persist();
      let result;
      try { result = await this.gh.call(repo, `/pulls/${pr.number}/merge`, 'PUT', { sha: pr.head.sha, merge_method: repo.mergeMethod }); }
      catch (error) { if (error?.yieldEffect) throw error;
        if (error.status && error.status < 500) { delete record.pendingMerge; this.persist(); }
        throw error;
      }
      if (!result.merged) { delete record.pendingMerge; this.persist(); return { action: 'merge-blocked', number: pr.number, message: result.message }; }
      record.lastMerge = new Date().toISOString(); this.persist();
      await this.cleanup(repo);
      return { action: 'merged', number: pr.number, sha: result.sha };
    }
    return { action: 'no-eligible-pr' };
  }
  async run(mode, repoName, dryRun = true) {
    const repo = this.config.repositories.find(r => r.name === repoName);
    if (!repo) throw new Error('Repository is not configured');
    if (this.locks.has(repo.name)) return { repository: repo.name, action: 'busy' };
    this.locks.add(repo.name);
    try {
      let result;
      if (!dryRun) { await this.cleanup(repo); await this.flush(repo); }
      if (mode === 'monitor') {
        const prs = await this.gh.pages(repo, '/pulls?state=open&sort=created&direction=asc');
        result = [];
        for (const pr of prs.filter(p => this.eligible(repo, p))) {
          try { result.push(await this.monitorPr(repo, pr.number, dryRun)); }
          catch (e) { if (e?.yieldEffect) throw e; result.push({ number: pr.number, action: 'error', error: e.message }); }
        }
      } else result = await this.merge(repo, dryRun);
      if (!dryRun) await this.flush(repo);
      return { repository: repo.name, dryRun, result };
    } finally { this.locks.delete(repo.name); }
  }
}





const env=$input.first().json;
const state=JSON.parse(JSON.stringify(env.initialState));
let cursor=0;
class YieldEffect extends Error { constructor(effect){super('yield');this.yieldEffect=effect;} }
function effect(value){
  const previous=env.log[cursor++];
  if(!previous)throw new YieldEffect(value);
  if(JSON.stringify(previous.effect)!==JSON.stringify(value))throw new Error('Effect replay mismatch; lock retained for inspection');
  const response=previous.response;
  if(response.error || response.statusCode>=400){const e=new Error(response.safeMessage || ('API request failed: '+(response.statusCode||'network error')));e.status=response.statusCode;throw e;}
  return response.body;
}
const gh={
  call:async(repo,path,method='GET',body)=>effect({kind:'github',path:'/repos/'+repo.name+path,method,...(body===undefined?{}:{body})}),
  pages:async(repo,path,field)=>{const output=[];for(let page=1;page<=50;page++){const value=await gh.call(repo,path+(path.includes('?')?'&':'?')+'per_page=100&page='+page);const items=field?value[field]:value;if(!Array.isArray(items))throw new Error('Invalid paginated API result');output.push(...items);if(items.length<100)return output;}throw new Error('Pagination limit; refusing incomplete data');}
};
const repo={name:env.args.repository,...env.args};
const manager=new Manager({config:{appSlug:env.args.appSlug,repositories:[repo]},github:gh,state,save:()=>{},notify:async content=>effect({kind:'discord',content:content.slice(0,1900).replace(/@/g,'@\u200b')})});
try{
  const result=await manager.run(env.args.mode,repo.name,env.args.dryRun);
  return [{json:{...env,state,effect:{kind:'done'},result}}];
}catch(error){
  if(error.yieldEffect)return [{json:{...env,state,effect:error.yieldEffect}}];
  return [{json:{...env,state,effect:{kind:'done'},fatal:error.message,result:{repository:repo.name,error:error.message}}}];
}

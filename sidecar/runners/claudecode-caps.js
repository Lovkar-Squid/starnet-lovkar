/* sidecar/runners/claudecode-caps.js — THE MOAT, projected onto Claude Code.

   StarNet's rule is that placing an object on the floor IS granting a capability. A Claude
   Code run used to ignore that completely: it shipped one hardcoded tool list no matter what
   was in the agent's room, which made the floor a decoration. This module is the projection
   that makes it mean something again.

     resolveClaudeCaps({ objects, vaultRoot, workdir, fullPower }) ->
       { tools[], cwd, addDirs[], confined, allowed[], grantedBy{}, unmapped[], summary }

   Pure: same inputs -> same output. No fs, no spawn, no env.

   HOW THE GATE IS ENFORCED — this matters, because the obvious mechanism does not work.
   Measured against this CLI build (lovkar/probe-permissions.js, 7 cases): a path-qualified
   `--allowedTools Write(vault/**)` rule is NEVER honoured. Every spelling was refused —
   relative, absolute, forward slashes, backslashes, the `//` prefix, with and without
   --add-dir. Only the BARE tool name grants. So scoping cannot come from the allow patterns,
   and it comes from the two documented knobs instead (lovkar/probe-restricted.js, 5 cases,
   including the escape attempts that must fail):

     --tools <names>   decides which built-in tools EXIST at all   <- object grants the tool
     --restricted      confines the file tools to the working roots <- object grants the reach

   Consequence worth stating plainly: --restricted allows ONE set of roots for all file tools,
   so "read the whole project but write only the vault" is not expressible. A notebook alone
   therefore means vault-only, reads included: a mind with a diary and no filing cabinet. Add
   the cabinet and the project opens up.

   TWO DIALS, NOT ONE. The floor decides WHICH TOOLS exist; the Commander's FULL POWER
   posture decides WHETHER THE FILE TOOLS ARE CONFINED. They are independent on purpose:
   --tools removes a tool from the built-in set before permissions are consulted at all, so
   the floor keeps its meaning at every authority level — FULL POWER can never hand an agent
   a workbench that is not on the floor. What it does drop is --restricted, and with it the
   folder boundary, because the CLI refuses the two together:
   `Error: bypassPermissions not supported in restricted mode`.

   Confined is the default. Turning it off means a placed cabinet stops meaning "this project"
   and starts meaning "any folder on this machine", and a placed workbench runs shell commands
   with no path boundary at all.

   THE ONE DELIBERATE DIVERGENCE FROM UPSTREAM'S MOAT. The vault is a freebie: every run can
   read and write it even with an empty room. Upstream gives `compute` free so an agent can
   always think; the same argument applies to remembering, and the vault is StarNet's own
   folder rather than the Commander's data. It is a choice, not an oversight — if it should
   ever become earned, delete BASE_TOOLS and let `notebook` carry it.
*/
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.SK = root.SK || {}; root.SK.runners = root.SK.runners || {}; root.SK.runners.claudecodeCaps = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* The object -> tool table, read off sidecar/capability/registry.js so the two cannot drift
     into different stories about what a piece of furniture means:
       notebook  = memory    (notebook.*, skill.*, recall)   -> the vault
       cabinet   = files     (fs.read/list/search/write/…)   -> the working folder
       dish      = web       (web_search, web_fetch, browser.*)
       workbench = terminal  (shell.exec, terminal.*)
       orchestrator = team   (team.dispatch/spawn/…)
     `roots` names a root symbolically; resolveClaudeCaps turns the names into real paths. */
  const MAP = {
    notebook:     { tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit'], roots: ['vault'] },
    cabinet:      { tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'NotebookEdit'], roots: ['workdir'] },
    dish:         { tools: ['WebSearch', 'WebFetch'], roots: [] },
    workbench:    { tools: ['Bash', 'BashOutput', 'KillShell'], roots: [] },
    orchestrator: { tools: ['Task'], roots: [] },
    // Placed, real, and with no Claude Code equivalent. Named rather than silently dropped so
    // the run can say so instead of leaving the Commander wondering why the prop does nothing.
    computer:     { tools: [], roots: [], why: 'compute — the model itself, always on' },
    studio:       { tools: [], roots: [], why: 'StarNet-native image/voice tools; a Claude Code run has no equivalent' },
    jukebox:      { tools: [], roots: [], why: 'StarNet-native Spotify tools; reachable only once wired as an MCP server' },
    connector:    { tools: [], roots: [], why: 'MCP connector; needs --mcp-config, not a built-in tool' }
  };

  // The freebie. TodoWrite is upstream's `todo` from the computer/compute family, so it rides
  // along for free there too; Read/Glob/Grep/Write/Edit are scoped to the vault by `cwd`.
  const BASE_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'TodoWrite'];

  const ORDER = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'NotebookEdit', 'TodoWrite',
                 'WebSearch', 'WebFetch', 'Bash', 'BashOutput', 'KillShell', 'Task'];

  function norm(p) {
    let s = String(p == null ? '' : p).split('\\').join('/');
    while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
    return s;
  }
  // Case-insensitive because this runs on Windows, where D:\X and d:\x are one directory.
  function within(child, parent) {
    const c = norm(child).toLowerCase(), p = norm(parent).toLowerCase();
    return c === p || c.startsWith(p + '/');
  }

  function typesOf(objects) {
    const out = [], seen = {};
    for (const o of (Array.isArray(objects) ? objects : [])) {
      const t = typeof o === 'string' ? o : (o && o.objectType);
      if (!t || seen[t]) continue;
      seen[t] = true;
      out.push(String(t));
    }
    return out;
  }

  function resolveClaudeCaps(o) {
    o = o || {};
    const vaultRoot = String(o.vaultRoot || '');
    const workdir = String(o.workdir || '');
    const types = typesOf(o.objects);

    const tools = {}, roots = { vault: true }, grantedBy = {}, unmapped = [];
    for (const t of BASE_TOOLS) { tools[t] = true; grantedBy[t] = 'vault (freebie)'; }

    for (const t of types) {
      const m = MAP[t];
      if (!m) { unmapped.push({ objectType: t, why: 'unknown object type' }); continue; }
      if (!m.tools.length) { unmapped.push({ objectType: t, why: m.why || 'grants nothing here' }); continue; }
      for (const x of m.tools) { if (!tools[x]) grantedBy[x] = t; tools[x] = true; }
      for (const r of m.roots) roots[r] = true;
    }

    const list = ORDER.filter(t => tools[t]).concat(Object.keys(tools).filter(t => ORDER.indexOf(t) < 0).sort());

    // The working root IS the write boundary under --restricted, so choosing cwd is choosing
    // the moat. Without a cabinet the run lives inside the vault and can reach nothing else.
    // FULL POWER removes the boundary rather than widening it, so it starts from the project.
    const confined = !o.fullPower;
    const wantsWorkdir = (!!roots.workdir || !confined) && !!workdir;
    const cwd = wantsWorkdir ? workdir : (vaultRoot || workdir);
    const addDirs = [];
    if (vaultRoot && !within(vaultRoot, cwd)) addDirs.push(vaultRoot);

    const summary = [
      'placed: ' + (types.length ? types.join(', ') : '(nothing)'),
      'tools: ' + list.join(', '),
      (confined ? 'can write in: ' + [cwd].concat(addDirs).join(' + ')
                : 'UNCONFINED (FULL POWER) — no folder boundary, running from ' + cwd)
    ].join(' | ');

    return { tools: list, allowed: list.slice(), cwd, addDirs, confined, roots: Object.keys(roots), grantedBy, unmapped, placed: types, summary };
  }

  /* The block appended to the system prompt. An agent that knows its real reach stops burning
     turns on tools that were never going to answer — the failure mode that produced a run
     spent discovering its own permissions instead of doing the work. */
  function capsPrompt(caps) {
    const lines = [
      'CAPABILITIES THIS RUN — decided by what the Commander placed in your room, not by you.',
      '',
      'Tools you actually have: ' + caps.tools.join(', ')
    ];
    if (caps.confined) {
      lines.push('Folders you may read and write: ' + [caps.cwd].concat(caps.addDirs).join(' , '),
                 'Everything outside those folders is refused by the host, not by your judgement.');
    } else {
      lines.push('Working folder: ' + caps.cwd,
                 'FULL POWER is on, so there is NO folder boundary and nothing will stop you.',
                 'That makes care your job rather than the host\'s: stay inside the work you were',
                 'asked to do, and never touch anything outside it just because you can.');
    }
    if (caps.unmapped.length) {
      lines.push('', 'Placed but inert for a Claude Code run:');
      for (const u of caps.unmapped) lines.push('  · ' + u.objectType + ' — ' + u.why);
    }
    const missing = ['Bash', 'WebSearch', 'WebFetch'].filter(t => caps.tools.indexOf(t) < 0);
    if (missing.length) {
      lines.push('', 'You do NOT have: ' + missing.join(', ') + '. Do not try them and do not look for a',
                     'way around them — say what you would need and which object grants it',
                     '(workbench = shell, dish = web, cabinet = the project folder).');
    }
    return lines.join('\n');
  }

  return { resolveClaudeCaps, capsPrompt, MAP, BASE_TOOLS };
});

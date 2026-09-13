# Website navigation font restoration

The user preferred the top-bar font from the previous public design. The homepage and
other shared headers still had a small system-font override from the initial redesign.

- Restored the original self-hosted VT323 navigation face, 16px desktop / 15px mobile
  sizes, uppercase labels and 1.5px desktop / 1px mobile letter spacing.
- Kept the current navigation structure, docs organization and glass surfaces. Removed
  the docs-specific type override so the shared header uses the same font treatment.
- At widths up to 400px, the secondary brand context yields space to the navigation and
  download action. Existing destinations remain accessible.
- Updated the CSS cache versions, including nested guide imports and unversioned legal
  stylesheet links, so returning visitors receive the correction.
- Source candidate: `fa85f521f8be9b7a6a43c9232d4e6a3041f5374d`, based on trunk
  `091d6e7f312e08ca9e813e94f7b8863d1a5d9e5a` in the owned website worktree.
- Local live proof: homepage, docs overview, guide library and privacy page at 320, 390,
  768 and 1440px. After document parsing and font loading, all 16 combinations used
  VT323, showed a single navigation row and had no clipped header links. Visually
  inspected the restored homepage top bar at the normal browser width.
- Navigation suite passed 1,323 assertions, including 1,079 internal links. Staging suite
  passed 25 assertions. Shell generator check: 31 pages, zero drift. Syntax and whitespace
  checks passed.

This is a website typography correction, with no installed desktop release claim.

## Publication

- Exact candidate CI passed **772/772** fast steps and **34/34** customer-journey steps:
  https://github.com/androoAGI/starnet/actions/runs/34735586859.
- Integrated by exact fast-forward to `fa85f521f`; the tested commit and merged source
  are identical. Existing uncommitted NEXT, QA status and Rooms handoff bytes were preserved.
- Published guarded `website-deploy` to Cloudflare Pages production deployment
  `40aa7c3e-3127-45f0-a253-520f03cb514a`:
  https://40aa7c3e.starnet-site.pages.dev. Prior production `759986f1` is retained.
- Live https://starnetos.com/ renders VT323, 16px, 1.5px spacing, uppercase labels and
  a 72px desktop header. Visually verified the public top bar after deployment.
- Public-domain verification passed for all 24 docs pages, 12 assets and five other pages;
  source matched staging after reversing only Cloudflare email obfuscation in HTML.
- This receipt and QA status row were recorded in the owned worktree after publication;
  the integration tree's foreign uncommitted status remains untouched.

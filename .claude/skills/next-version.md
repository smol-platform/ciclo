---
name: next-version
description: "Use when the user invokes /next-version or asks to choose, bump, and record the next SemVer version from git history before running the release skill. The skill inspects changes since the last release tag, derives major/minor/patch using Conventional Commit and SemVer rules, updates canonical version files, and records only the version bump."
---

# Next Version

Prepare the repository for a release by recording exactly one version bump. Do not create tags, push, or publish releases; after this skill succeeds, hand off to `/release <tag>` or the release skill.

## Workflow

1. Verify the repository state.
   ```bash
   git status --short
   git branch --show-current
   git fetch --tags --prune origin
   git status --short
   ```
   Stop if the worktree is dirty before the version bump. The version-bump revision must not include feature, test, documentation, Beads, generated cache, or unrelated edits.

2. Find the release base.
   ```bash
   git describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null
   git log --oneline --decorate --max-count=20
   ```
   Use the latest reachable `v*` tag as the base. If no release tag exists, use `0.0.0` as the version base and inspect the full reachable history.

3. Classify the next bump.
   - Explicit user input wins when it says `major`, `minor`, `patch`, or a concrete tag like `v1.2.3`.
   - Otherwise inspect history since the base tag:
     ```bash
     git log --format='%H%x09%s%x09%b' <base-tag>..HEAD
     ```
   - Choose `major` for `BREAKING CHANGE`, `BREAKING-CHANGE`, or a Conventional Commit bang such as `feat!:` or `fix(api)!:`.
   - Choose `minor` when there is any `feat:` or `feat(scope):` entry and no major signal.
   - Choose `patch` when there is any `fix:`, `perf:`, `refactor:`, `docs:`, `test:`, `chore:`, `build:`, `ci:`, or other non-empty release-worthy entry and no major/minor signal.
   - Stop without changing files when there are no changes since the base tag, or when the only new revision is already `Bump version to vX.Y.Z` and canonical version files already match that tag.
   - Do not invent nonstandard pre-`1.0.0` rules unless the repository documents them. SemVer `major` increments the major component, `minor` increments minor and resets patch, and `patch` increments patch.

4. Compute and verify the target.
   - Normalize tags as `v<version>` when the repo uses `v*` tags.
   - Derive `version` from `tag` by removing the leading `v`.
   - Verify the target tag does not already exist locally or remotely:
     ```bash
     git rev-parse -q --verify "refs/tags/<tag>"
     git ls-remote --tags origin "<tag>"
     ```
   - Stop if package metadata already has a different version than the base tag and the reason is unclear.

5. Bump canonical version files.
   - For Node packages:
     ```bash
     npm version "<version>" --no-git-tag-version
     ```
     This updates `package.json` and `package-lock.json` when both are present.
   - For Python packages with `pyproject.toml`, update only `project.version = "<version>"` unless the repo has a documented version helper.
   - Update every canonical version file the repository uses; do not update examples, docs, generated files, or changelogs unless the repository explicitly treats them as canonical release metadata.

6. Inspect and validate the bump.
   ```bash
   git diff --stat
   git diff -- package.json package-lock.json pyproject.toml uv.lock
   git diff --check
   ```
   Stop if any unrelated file changed. Confirm every canonical version file reports the same target version.

7. Record only the version bump.
   - Stage only existing canonical version files that changed.
   - Create one Git revision with message `Bump version to <tag>`.
   - If the repository gate asks for an opt-in variable, use only the documented version-control approval variable for this one version-bump revision.

8. Hand off to release.
   Report the computed bump type, base tag, target tag, version files changed, and new revision hash. Tell the operator to run `/release <tag>` next.

## Safety Rules

- Never tag, push, create a GitHub release, or run Beads remote sync in this skill.
- Never record non-version changes.
- Never move, delete, or overwrite an existing tag.
- Stop rather than guessing when history, version files, or release branch state disagree.

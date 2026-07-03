---
name: release
description: "Use when the user invokes /release or asks Claude or Codex to cut a repository release: update local state from remote, run release gates, create a new git tag, publish the branch and tag to the remote, and create a GitHub release with gh."
---

# Release

Use this skill to publish a GitHub-backed repository release. A direct `/release` request grants authority to fetch, fast-forward the local branch, create a tag, publish the current release branch and tag, and create a GitHub release when the target version and branch are unambiguous. Do not force-publish, rewrite tags, bypass gates, or publish from a dirty worktree.

## Workflow

1. Establish the release target.
   - Prefer an explicit tag from the user, such as `/release v0.2.0`.
   - If no tag is supplied, derive it from the repository canonical version file only when obvious, such as `package.json`, `pyproject.toml`, or an existing project version module.
   - Normalize release tags to the repository convention. If the repo has existing `v*` tags, use `v<version>`.
   - Stop and ask when the tag, release branch, prerelease status, or notes source is unclear.

2. Verify local and remote state before changing anything.
   ```bash
   git status --short
   git remote -v
   git branch --show-current
   git fetch --tags --prune origin
   git pull --ff-only origin "$(git branch --show-current)"
   git status --short
   ```
   Stop if the worktree is dirty, the branch cannot fast-forward, the remote is missing, or the user is not on the intended release branch.

3. Check that the tag is new.
   ```bash
   git rev-parse -q --verify "refs/tags/<tag>"
   git ls-remote --tags origin "<tag>"
   ```
   Stop if either command finds the tag. Never delete or move an existing release tag unless the user explicitly asks for repair and approves the exact risk.

4. Run the repository release gate.
   - Use the repo documented full gate first, such as `just check`, `devenv shell ciclo-check`, `npm test`, or the release instructions in project docs.
   - If no gate is documented, run the narrowest build/test commands that prove the package can be released.
   - Stop on any failure and report the failing command.

5. Create and publish the release.
   ```bash
   git tag -a "<tag>" -m "Release <tag>"
   git \
     push origin "$(git branch --show-current)"
   git \
     push origin "<tag>"
   gh release create "<tag>" --target "$(git branch --show-current)" --title "Release <tag>" --generate-notes
   gh release view "<tag>" --json url,tagName,isDraft,isPrerelease
   ```
   Use `--prerelease` only when the tag or user request clearly indicates a prerelease. Use `--draft` only when requested.

6. Report the result.
   - Include the tag, branch, validation command and result, published remote, and GitHub release URL.
   - Include any local changes still present after release. There should normally be none.

## Safety Rules

- Do not release from a dirty worktree.
- Do not create a release from unpublished or unvalidated changes unless the user explicitly confirms that this is the release branch state.
- Do not use forced publishing, `git tag -f`, `gh release delete`, or tag deletion in normal release flow.
- Do not paste tokens or credentials into commands. If `gh` is not authenticated, stop and ask the user to authenticate.
- If this repo uses Beads, close only release-specific work that was actually completed and include release validation evidence.
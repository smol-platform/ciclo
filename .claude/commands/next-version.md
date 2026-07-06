Use the next-version skill to prepare this repository for release.

If the user supplied arguments after `/next-version`, treat them as an explicit SemVer bump, target tag, or release-prep instruction. Follow the next-version skill exactly: require a clean worktree, derive the target from git history when not explicit, bump canonical version files, record only the version bump with message `Bump version to <tag>`, and then tell the user to run `/release <tag>`.

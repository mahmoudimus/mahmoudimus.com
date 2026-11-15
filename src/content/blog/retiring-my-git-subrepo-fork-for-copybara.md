+++
Title: Retiring my git-subrepo fork for Copybara
Slug: retiring-my-git-subrepo-fork-for-copybara
Date: 2026-11-15
Status: published
Author: Mahmoud
Tags: git, monorepo, copybara, git-subrepo
Classification: blog
Excerpt: I kept a fork of git-subrepo alive for four years. This month I brought it up to date, fixed the bugs I found, and then recommended Copybara in its README. Here is why.
+++

# Retiring my git-subrepo fork for Copybara

In 2022 I forked [git-subrepo](https://github.com/ingydotnet/git-subrepo). Upstream had a pile of open pull requests that fixed real problems: nested subrepos, a push that dropped commits, tests that failed if your default branch wasn't `master`. I merged the ones I needed into [my fork](https://github.com/mahmoudimus/git-subrepo) and used it.

This month I needed it again, to keep thirteen Java repositories in sync with the monorepo they had moved into. I brought the fork up to date, fixed what I found, and got the test suite to pass. Then I put this at the top of its README: use Copybara instead.

## What I fixed first

The fork was 60 commits behind upstream. Merging upstream back in took 14 conflict hunks across 9 files. Upstream had picked up worktree cleanup after push, a pull strategy for git 2.33 and later, and `.gitrepo` stripping limited to first-parent commits.

Then three bugs:

- `push` straight after `subrepo commit` died with `cd: null directory`. `commit` leaves a branch behind, and `push` then skipped setting the worktree path it later `cd`s into. Upstream 0.4.9 still has this.
- `reclone --branch` stopped recording the new branch in `.gitrepo`, because my fork had made those writes depend on `-u`.
- One of the 2022 fixes, which starts the push branch from the latest synced commit, passed a commit parent as a single word, `"-p <sha>"`, instead of two. With `--method rebase`, `git commit-tree` failed with `not a valid object name`, and push quietly fell back to another path. It had been wrong for four years and no test noticed. There is one now.

The suite went from 349 tests with one failure to 360 with none. Two of the fork's three open pull requests had already landed upstream, and the third was already in the fork. Nothing is left to merge.

So the tool works. It still isn't the right tool for this job.

## Where git-subrepo stops

git-subrepo tracks a sync with a small `.gitrepo` file in the directory: the upstream remote and branch, the last upstream commit synced, and the monorepo commit that matches it. To push, it rebuilds the monorepo commits since then as new commits on top of the upstream commit and pushes them. Everything depends on those commit IDs and the history linking them.

The upstream repositories here are protected the way most company repositories are. The default branch takes changes only through a pull request with signed commits and passing checks, and squash is the only merge method allowed. That rules out three things git-subrepo assumes.

**Squash merges break the record.** The push goes to a side branch and is merged through a pull request. The squash creates a new commit that isn't descended from what was pushed, so `.gitrepo` now points at a commit the default branch will never contain. The next `pull` fails with `Local repository does not contain <sha>`. I wrote a re-anchor step that, after each merge, checks the squash commit has the same files as the push, then rewrites `commit` and `parent` in `.gitrepo` and deletes the sync branch. It worked through three push-and-squash cycles. But it is a script around the tool, and it runs after every merge, forever.

**Pull requests are someone else's job.** git-subrepo pushes a branch. It doesn't open the pull request or update it, and the commits it creates aren't signed. Something else has to do all of that.

**The files can't differ.** git-subrepo copies the directory byte for byte. Inside the monorepo, each module's `pom.xml` inherits from the monorepo root and depends on its sibling modules at a shared snapshot version. Neither exists upstream, so the exported pom can't build there, and the pull request fails the checks it must pass to merge. git-subrepo has no step where a file can change on its way out.

Underneath all of this, git-subrepo is about 2,000 lines of bash built on `git filter-branch`, which git itself now warns against using, and on temporary worktrees that block the next command when one is left behind. Several of the bugs above came from that design.

## What Copybara does instead

[Copybara](https://github.com/google/copybara) is Google's tool for moving code between repositories. It answers each of those three problems by design, not with a script around it.

- **It tracks syncs with a label, not commit IDs.** Each commit Copybara writes carries a line in its message naming the source commit, such as `Monorepo-RevId: <sha>`. On the next run it looks for the newest label in the destination's history. A squash merge keeps the label as long as the squash message includes the commit messages, which is GitHub's default. Nothing needs re-anchoring.
- **Pull requests are part of the workflow.** It can push to a branch for a pull request or open and update the pull request itself (`git.github_pr_destination`). In the other direction, it can import an upstream pull request as a patch on the monorepo commit that pull request was based on.
- **It changes files on the way out.** Transformations move, rename and rewrite files during export, and `core.reverse` undoes them on import. Each module keeps two poms: the monorepo one, which never leaves, and a standalone one that is exported as `pom.xml`. A pull request that edits the pom upstream lands in the standalone pom when imported.

It isn't free. You write the config in Starlark, the current release needs Java 25, and it keeps its cache in `~/copybara` whatever `user.home` says. It also wants one writer: the monorepo owns the upstream default branch, and upstream contributions arrive as pull requests that get imported. My first design synced the default branch in both directions. It silently reverted upstream changes it hadn't imported yet, and once committed conflict markers. Taking the one-writer setup Copybara is built around fixed both.

The full comparison, with every scenario I ran and the config, is in a follow-up post.

## When git-subrepo is still fine

If the other repository has no branch protection, takes direct pushes, and builds from exactly the files in your directory, git-subrepo is less to set up: one `.gitrepo` file, bash and git. `push` and `pull` from a terminal are all you need.

Once squash-only merges, required checks, or a build file that must differ come into it, the bookkeeping moves out of the tool into scripts you have to maintain, and Copybara is the better fit.

## What happens to the fork

The fork stays up, current with upstream as of February 2026, with its fixes listed in the README and the Copybara recommendation above them. I won't be adding to it. The `cd: null directory` fix is small and self-contained, and is the one worth sending upstream.

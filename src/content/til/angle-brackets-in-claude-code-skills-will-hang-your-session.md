---
Title: Angle Brackets in Claude Code Skills Will Hang Your Session
Date: 2026-02-09
category: debugging
tags: claude-code, skills, debugging, hooks, cli
classification: til
author: Mahmoud
excerpt: A `<PLACEHOLDER>` in a Claude Code skill file silently hangs the entire session on startup...
---

Today I learned that a single `<PLACEHOLDER>` in a Claude Code skill file can silently hang your entire session on startup. No error, no crash — just a frozen terminal staring back at you. That one innocent angle bracket...

## The Problem

I was building a custom skill for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) at `.claude/skills/simba-onboard/skill.md` that used `<CORE_FILE>` as a template variable throughout the document:

```markdown
## Step 3: Generate .claude/rules/<CORE_FILE>

Create the file `.claude/rules/<CORE_FILE>` with this structure:
```

After adding this skill, I tried launching Claude Code in the project directory and... nothing. Completely frozen. Even `--resume` wouldn't work. Just a dead terminal.

## The Debugging Journey

### Step 1: Is It Just This Project?

I launched Claude Code from a different directory and it started right up. So something specific to this project was killing it.

### Step 2: Bisect `.claude/`

I moved `.claude/` out to `.claude.bak` — Claude started immediately. Moved it back — frozen again. Getting warmer.

### Step 3: Which Piece?

The `.claude/` directory had `settings.local.json`, `rules/`, `handoffs/`, and `skills/`. I started moving things out one by one. Moving `skills/` out fixed it. Moving it back? Frozen again. There it was.

### Step 4: The Content, Not the Structure

I replaced `skill.md` with a tiny test file — just valid YAML frontmatter and a single line of body text. Claude started fine. So it wasn't the directory or the frontmatter — something in the markdown content itself was the problem.

### Step 5: The `<ANGLE_BRACKET>` Breakthrough

The skill had 10 instances of `<CORE_FILE>` scattered through the document. I replaced them all with `{CORE_FILE}` and... Claude started instantly.

Can you see it? Those `<CORE_FILE>` angle brackets were being parsed as HTML/XML-like tags by the skill parser, and it was choking on them — silently, with zero feedback.

## The Fix

Simple fix, just swap angle brackets for `${...}` syntax:

```markdown
# Before (hangs Claude Code)
Create the file `.claude/rules/<CORE_FILE>` with this structure

# After (works fine)
Create the file `.claude/rules/${CORE_FILE}` with this structure
```

## The Insidious Part

The reason this ate so much time is that there's absolutely no feedback. No error message, no log output, no partial startup. Claude Code just sits there. If you didn't know to suspect the skills directory, you could spend forever chasing hooks, daemon issues, corrupt session files, or bad settings — all of which were red herrings.

The next time Claude Code freezes on startup with no error, check your skill files for angle brackets! 🔍 And knowing that sweet sweet bisection debugging can save you HOURS of staring at a frozen terminal.

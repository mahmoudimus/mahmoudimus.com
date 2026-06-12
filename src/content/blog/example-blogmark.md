+++
Title: Regular expression matching can be simple and fast
Date: 2026-06-12
Status: draft
Link: https://swtch.com/~rsc/regexp/regexp1.html
Via: https://news.ycombinator.com/
Tags: performance, programming
+++

<!-- TEMPLATE: this is an unpublished example blogmark. Copy this file, remove
     the `Status: draft` line, and replace the Link/Via/quote/commentary with
     your own. The `Link:` field is what turns a post into a blogmark. -->


> This algorithm ... runs in linear time, while the backtracking approach ... can require exponential time.

A clean reminder that the "slow regex" you hit in production is usually the
backtracking engine, not the theory. Worth re-reading before you reach for a
bigger box.

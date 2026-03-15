---
title: Nova 1.0
description: Entering the major release era.
date: 2026-03-15
authors:
  - name: Aapo Alasuutari
    url: https://github.com/aapoalas
---

Today, Nova JavaScript engine has published its first major version 1.0.0! This
marks the beginning of a new era for the engine where experimental status is
shed and a relative stability and polishing takes over. This does not mean that
the engine promises to stay unchanged or even that it is a perfect and
fully-formed product, however.

## Shortcomings

First it is important to acknowledge some big shortcomings of the engine: if
you're shopping around for a JavaScript engine for a big product or project,
we'd be happy if you take a look at Nova as a prospective engine but it is very
possible it is not the engine for you.

First, the engine's performance is acceptable or even fairly good on small
datasets and quick scripts, but it is _not_ a fast engine. Performance
optimisations are unfortunately being shipped on a later ship, and you'll be
sorely disappointed if you are looking for a V8 killer.

The engine also still has some bigger gaps in its ECMAScript support: the
`RegExp` object and engine especially are not specification compliant, differing
on Unicode and character set matching, nor supporting lookaheads, lookbehinds,
or backreferences. Arrays in the engine do not support sparse storage
internally, which means that setting the `length` property of an array to be
excessively large will also reserve excessive amounts of memory. Subclassing of
`Promise`s also does not work, and a bug currently stops class fields from
working on subclasses as well. Finally, no WebAssembly support exists at
present.

But if what you're looking for is a lightweight, easy-to-embed engine for
running scripts on the smaller side then Nova just might be the engine for you!

## Versioning strategy

Entering the major version era means that SemVer rules will be followed from now
on: the 1.x family will have backwards compatibility. That doesn't mean that the
API of the engine won't change, however. Rather, Nova will be following a
similar versioning model to V8: small, incremental breaking changes may happen
relatively frequently and in that case new major versions will be published. The
intent is to publish a new version roughly every few months at least, meaning
that if need be then new major versions will be published every few months as
well.

Major versioning gives us a versioning scheme we can use to guarantee backwards
compatibility with, but we do not aim to give LTS-like API stability guarantees
for the foreseeable future.

## Onwards!

That's all I wanted to say: Nova is now in the major version era, don't expect
miracles but do expect a little! Thank you for reading and see you in future
patch, minor, and major releases!

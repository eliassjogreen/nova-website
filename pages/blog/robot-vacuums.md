---
title: Robot vacuums
description: Keeping clean using custom lints
date: 2026-01-04
authors:
  - name: Elias Sjögreen
    url: https://github.com/eliassjogreen
---

Over the past year, the Nova engine has grown and matured immensely as a
project. We are at almost 80% [test262](https://trynova.dev/test262) coverage,
at 121845 lines of actual code excluding comments, a total of 24 contributors
and more than 800 commits. Maintaining such a project is no small task; It's a
whole lot of work which does not involve writing code: Welcoming people to our
[Discord](https://discord.gg/bwY4TRB8J7), writing
[blog](https://trynova.dev/blog/) and
[Bluesky](https://bsky.app/profile/trynova.dev) posts,
[doing talks](https://trynova.dev/talks) and of course code reviews.

The developers of Nova enjoy all of this of course, most of the time at least.
We do it because it's a fun hobby project, a learning experience, and a labour
of love which we wish to share with our and the wider community. We do not wish
to be replaced by soulless machines welcoming people, writing posts and doing
talks. But getting into Nova is no small task, even though we wish it was.
Adding the simplest of builtin functions requires learning about the ECMAScript
standard, a bit of data-oriented design and last but certainly not least:
Wrangling our garbage collector.

We are of course there to guide you along the way, and the garbage collector
being difficult is not something we're unaware of. In fact, we are actively
working on making the experience of using the garbage collector better in
multiple ways[^1]. When getting started with contributing to Nova, one might
want to contribute something simple, for example a that JavaScript builtin you
felt we were missing, but quickly you realize that you indeed need to understand
why you are getting a bunch of compilation errors of the worst sort: Borrow
checker errors. Scary, we know... But you carry on despite the scary-looking
errors, you read our
[garbage collector documentation](https://github.com/trynova/nova/blob/main/GARBAGE_COLLECTOR.md)
found in a mysterious Markdown file in the main repository, probably a few of
our blog posts, probably a talk or two and of course a heaping lot of code. You
might start researching a bunch of other prerequisites which we mention like you
already know them, what the hell is even a "mark-and-sweep" garbage collector?
You just wanted to add a new builtin, but now you are deeper than you ever
wanted to go. After a bunch of unreadable borrow checker errors you really wish
there was an easier way. Maybe something like Clippy which could just point out
those stupid, easily solvable mistakes...

This is of course a lot, even for us sometimes. Getting to the point: I am lazy
and I don't always have time to wrangle the garbage collector or Rust lifetimes.
Sometimes I don't even understand or see the issue myself, even though it's so
common it's mentioned in our contribution guidelines. So in my infinite wisdom
and laziness I decided we probably could automate and formalize at least the
["rules of thumb" section](https://github.com/trynova/nova/blob/main/GARBAGE_COLLECTOR.md#rules-of-thumb-for-methods-that-take-gctoken)
of the garbage collector documentation.

## Being lazy

Alright, so how did we do this? About a year ago I stumbled upon
[Dylint](https://github.com/trailofbits/dylint) which is basically standalone
clippy, the Rust linter, but by doing a bunch of compiler and linker magic it
allows you to run and write your own lints which look and behave just like the
awesome Rust lints we all already know and love. After watching their
[EuroRust 2024](https://www.youtube.com/watch?v=MjlPUA7sAmA) talk and reading
what sparse documentation I could find about Dylint and Clippy I set out to
write some lints, how hard could it be?

### A first rule

To write a Dylint rule one uses the private rust compiler crates, the same as
Clippy uses. This means patterns from the Clippy source code translates quite
well to Dylint lints, a big help when getting started. Additionally the Clippy
project provides a [utils](https://crates.io/crates/clippy_utils) crate which
has a lot of useful helpers for writing lints. Our first lint will be a simple
lint checking that the ordering of parameters is correct and consistent
throughout the codebase, importantly we want the `Agent` to come first in the
parameter list and `GcScope` or `NoGcScope` to come last. In the case of the
garbage collection scopes this is actually for an important reason, namely that
it invalidates all values which refer to it:

```rust
let data = data.bind(gc.nogc());
call(agent, gc.reborrow(), data.unbind());
```

This case wouldn't work because `gc.reborrow()` invalidates `data` immediately,
meaning that when `data.unbind()` is being called the `data` is already
invalidated and illegal to use, leading to a borrow checker error.

To define a lint which catches badly formed function definitions we start by
some boilerplate using the `declare_late_lint` macro provided by Dylint:

````rust
dylint_linting::declare_late_lint! {
    /// ### What it does
    ///
    /// Checks that the gc scope is the last parameter of a function.
    ///
    /// ### Why is this bad?
    ///
    /// The gc scope parameter should be passed as the last parameter of a
    /// function because it invalidates all values which refer to it, take
    /// for example the following code:
    ///
    /// ```rust
    /// let data = data.bind(gc.nogc());
    /// call(agent, gc.reborrow(), data.unbind());
    /// ```
    ///
    /// This wouldn't work because `gc.reborrow()` invalidates `data` immediately,
    /// meaning that when `data.unbind()` is being called the `data` is already
    /// invalidated and illegal to use, leading to a borrow checker error.
    ///
    /// ### Example
    ///
    /// ```rust
    /// fn bar(gc: GcScope<'_, '_>, other: &Other) {}
    /// ```
    ///
    /// Use instead:
    ///
    /// ```rust
    /// fn foo(other: &Other, gc: GcScope<'_, '_>) {}
    /// ```
    pub GC_SCOPE_COMES_LAST,
    Warn,
    "the gc scope should be the last parameter of any function using it"
}
````

This defines the lint itself and all of the documentation around it. Next up is
implementing it which is done by implementing one of the two kinds of lint pass
traits in Clippy. Linting is either done early or late, where the main
difference is access to typing information. In our case we need the typing
information to determine if a function parameter is actually the garbage
collection scope or not. In our case we implement the `LateLintPass` and the
`check_fn` method, which is called for every function definition:

```rust
impl<'tcx> LateLintPass<'tcx> for GcScopeComesLast {
    fn check_fn(
        &mut self,
        cx: &LateContext<'tcx>,
        _: FnKind<'tcx>,
        _: &'tcx FnDecl<'tcx>,
        body: &'tcx Body<'tcx>,
        span: Span,
        _: LocalDefId,
    ) {
      ...
    }
}
```

The actual logic of the lint is simple, we iterate in reverse over the function
parameters while looking for the garbage collection scope type being used in a
place which is not the last of the parameters:

```rust
for param in body
    .params
    .iter()
    .rev()
    // Skip while the last parameter is the gc scope
    .skip_while(|param| {
        let ty = cx.typeck_results().pat_ty(param.pat);
        is_gc_scope_ty(cx, &ty) || is_no_gc_scope_ty(cx, &ty)
    })
    // We hit the first parameter that is not a gc scope, so we can
    // safely skip it without worrying about it being a gc scope
    .skip(1)
{
    ...
}
```

And lastly if we find it being used before that we emit a warning:

```rust
let ty = cx.typeck_results().pat_ty(param.pat);
if is_gc_scope_ty(cx, &ty) || is_no_gc_scope_ty(cx, &ty) {
    span_lint_and_help(
        cx,
        GC_SCOPE_COMES_LAST,
        param.span,
        "the gc scope should be the last parameter of any function using it",
        None,
        "consider moving the gc scope to the last parameter",
    )
}
```

That's it! Well, I glossed over some parts like the
[tests](https://github.com/trynova/nova/tree/main/nova_lint/ui) and the
[utility functions](https://github.com/trynova/nova/blob/main/nova_lint/src/utils.rs)
which check the type of the parameter, but those are fairly straightforward if
you wish to take a look yourself.

### The rest

Since that first lint (actually,
[it was three initial lints](https://github.com/trynova/nova/pull/574)) we have
added a few other lints checking for best practices and rules of thumb specific
to Nova. Here is a summary of the lints we have so far:

#### Regarding parameters and types

- [`Agent` comes first](https://github.com/trynova/nova/blob/main/nova_lint/src/agent_comes_first.rs):
  Checks that the `Agent` parameter is the first parameter of any function using
  it.
- [`GcScope` comes last](https://github.com/trynova/nova/blob/main/nova_lint/src/gc_scope_comes_last.rs):
  Checks that the `GcScope` or `NoGcScope` parameter is the last parameter of
  any function using it.
- [`GcScope` is only passed by value](https://github.com/trynova/nova/blob/main/nova_lint/src/gc_scope_is_only_passed_by_value.rs):
  Checks that the `GcScope` parameter is only ever passed by value, not by
  reference.
- [Can use `NoGcScope`](https://github.com/trynova/nova/blob/main/nova_lint/src/can_use_no_gc_scope.rs):
  Checks that any function not taking advantage of the garbage collection scope
  (`GcScope`) instead uses `NoGcScope`.

#### Regarding documentation

- [No "it performs the following"](https://github.com/trynova/nova/blob/main/nova_lint/src/no_it_performs_the_following.rs):
  Checks that documentation comments don't contain the phrase "it performs the
  following" or similar. A remnant from copy-pasting from the TC-39
  specification.
- [No multipage spec](https://github.com/trynova/nova/blob/main/nova_lint/src/no_multipage_spec.rs):
  Disallows linking to the multi-page TC-39 specification in documentation
  comments.
- [Spec header level](https://github.com/trynova/nova/blob/main/nova_lint/src/spec_header_level.rs):
  Checks that the header level of your documentation comments matches the header
  level of the TC-39 specification, with a maximum cap of three levels.

## Using our lints

Dylint is not a tool specific to our codebase even though it currently only runs
in our codebase. It's built not only for us but for all who wish to embed or use
Nova within your own project. Using it should be as simple as adding this
section to your `Cargo.toml`:

```toml
[workspace.metadata.dylint]
libraries = [{ git = "https://github.com/trynova/nova", path = "nova_lint" }]
```

And then running it using: `cargo dylint --all`. Some of our lints can even fix
issues automatically using `cargo dylint --fix --all`.

## Our hope

Our hope is that these lints ease development for you whether you are using Nova
as a library or want to contribute to the engine itself and hopefully our code
reviews will be less about pointing out these common issues and nitpicks
allowing us to rather focus on the more fun parts instead. Not unlike a robot
vacuum our lints hopefully help us and you to keep your codebase clean and
avoiding stupid avoidable mistakes. But keep in mind that just like a robot
vacuum can't climb down the stairs or over that doorstep our lints can't catch
everything, they are just here to help you along the way.

[^1]: Aapo is even contributing
    ["reborrow traits"](https://rust-lang.github.io/rust-project-goals/2025h2/autoreborrow-traits.html)
    to the Rust compiler, and it's one of the Rust projects 2026 flagship goals!

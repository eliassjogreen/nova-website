---
title: Contrarian thinking part 2 - The Reckoning
description: Making sense and finding limits of contravariance of garbage collected handles.
date: 2026-03-04
authors:
  - name: Aapo Alasuutari
    url: https://github.com/aapoalas
---

A few months ago [I stumbled upon a
realisation](./garbage-collection-is-contrarian) that garbage collected handles
hold their lifetimes as contravariant. This was, I still want to think, an
important discovery that I thought would bring ~~balance to the force~~ the joys
of borrow checking into areas where it has thus far not been available. I
might've been a overly optimistic, but perhaps also not fully wrong.

## Handles are covariant

Here's the first scoop: a handle's lifetime is not contravariant but covariant.
... Well, kind of. Let's take a few examples:

```rust
let handle: Handle<'gc> = heap.create_object();
heap.perform_gc();
```

Here we allocate some object structure on a garbage collected ("managed") heap,
take an unrooted handle to it, and then immediately perform GC. After the GC the
object has been removed as we only just created object and didn't root its
handle: no one refers to the object, hence it is collected. (Note: I am assuming
that the GC algorithm is precise, ie. the fact that we hold `handle` on the
stack or in a register does not automatically root it.)

If we say that some lifetime `'a` tracks the time between garbage collections,
then we can clearly say that the lifetime `'gc` of our unrooted handle must be
shorter than `'a`, ie. `'a: 'gc`, and any handle that is assigned over `handle`
must also have a lifetime that is equal to `'gc` or longer.

```rust
let handle: Handle<'gc> = heap.create_object();
let copy: Handle<'_> = handle;
heap.perform_gc();
```

If we make a copy of `handle`, that copy should also get an equivalent or
shorter lifetime than the original `'a`. This is all very clearly covariance.

## Handles are invariant

Here's the second scoop: a handle is of course invariant over the heap that it
refers to. This can be achieved through separate branding, but we can also argue
that a handle's lifetime itself is invariant:

```rust
let handle1: Handle<'gc1> = heap1.create_object();
let handle2: Handle<'gc2> = heap2.create_object();
heap1.perform_gc();
heap2.perform_gc();
```

If we have two heaps `heap1` and `heap2` and one handle created from both, then
there must also exist two lifetimes tracking the time between garbage
collection: one for each heap. Assuming we're capable of tracking garbage
collection safepoints, then we know exactly when these lifetimes start and end:
this means that these lifetimes are unique, and treating it as invariant is
perfectly valid. There is only one garbage collection lifetime that can be used
in its place, and that is the garbage collection lifetime itself.

Therefore it makes sense that handles tracking a garbage collection lifetime
ought to also consider the lifetime invariant: handles are invariant over their
lifetime.

## Handles are contravariant


Wait what? Well, yes: I wasn't hallucinating when I wrote the last blog post!
Handles indeed are contravariant:

```rust
let handle: Handle<'gc> = heap.create_object();
let slot: &mut Handle<'_> = heap.get_value_slot();
*slot = handle;
```

It _is_ valid to assign a handle from the stack onto the (managed) heap, despite
the fact that a handle on the stack has a short `'gc` lifetime that gets
invalidated by garbage collection while a handle on the managed heap has some
longer lifetime which is not invalidated by garbage collection. This is
obviously contravariance, no question about it!

## Handles are everything - what is going on?

The thing with handles is that their lifetime is not based on where they come
from, but on where they are stored in! This is what makes them very
unconventional indeed. Let's first look at a normal reference:

```rust
let a = Box::new(0u32);
let b1: &u32 = &a;
let b2: Box<&u32> = Box::new(b1);
let b3 = heap.store_ref_u32(b1);
drop(a);
```

Regardless of where we store the `b1` reference or a copy of it, its lifetime is
exactly defined by the lifetime of `a`. Similarly, even if we could not see the
`Box` but instead were taking a function parameter `&u32`, the lifetime would
still be the same regardless of where the reference gets stored.

But now let's compare this with a handle:

```rust
let b1 = heap.create_object();
let b2 = Box::new(b1);
let b3 = heap.root_handle(b1);
heap.perform_gc();
```

Here the lifetime of the handle varies depending on where it is stored and what
the garbage collector algorithm is. In a precise garbage collection algorithm
both `b1` and `b2` invalidate when garbage collection is run, while in a
conservative GC with stack scanning `b1` is not invalidated by garbage
collection but `b2` still is. The third, rooted copy of `b1` of course does not
get invalidated by garbage collection: it inherits the lifetime of the root.
Mildly interestingly, if the timing of garbage collection cannot be determined
then the lifetime of `b2` (or rather, the lifetime of the `b1` copy within the
`Box`) must be assumed to be `'empty` as garbage collection can happen after
`b1` has been copied into the allocation but before the next line over.

How can this be? Can we reason about consistently using lifetimes? Turns out,
... yes, sort of.

## Handles are nothing

We can partially express the above variations by removing the lifetime from
`Handle` entirely, and moving it into specific wrapper types:

```rust
let b1: Stack<'_, Handle> = heap.create_object();
let b2: Box<Heap<'_, Handle>> = Box::new(Heap::new(b1))
let b3: Root<'_, Handle> = heap.root_Handle(b1);
```

These wrappers can have covariant or invariant lifetimes, depending on
preference, which makes them safe to move and copy around. With this, we can
freely move handles between locations:

```rust
let slot: &mut Handle = heap.get_value_slot();
*slot = b1.get();
```

There are no lifetime issues here, because `Handle` no longer has a lifetime and
therefore writing a `Handle` into any of `Stack`, `Heap`, `Root`, or a `&mut
Handle` is always valid: you just need to get yourself a `Handle` from a valid
location first.

But have we actually solved anything here? We were trying to give garbage
collected handles a useful lifetime, and came up with the clever solution of
giving them no lifetime at all! This API is only safe if a plain `Handle` can
never be read out from any of the wrappers: `Handle` is therefore not `Copy` or
`Clone`, and can only ever be exposed as `&Handle`. A `Stack<Handle>` can be
`Copy` but can of course only be assigned on another `Stack<Handle>`, but not
for instance into a `&mut Handle` or `Root<Handle>`.

Any writing of `Handle`s from one source into another must therefore go through
specialised APIs. Any APIs operating on `Handle`s must likewise operate on
either `&self`, or on `self: Stack<Handle>` and other similar specialised
self-types (this requires a nightly feature called arbitrary self-types). Even
if those steps are handled, another issue remains: nothing stops users from
creating a `Box<Stack<Handle>>` or holding a `Heap<Handle>` on the stack. The
location wrappers cannot be relied on for soundness.

The final nail in the coffin of this beautiful dream is that because our
`Stack<Handle>` is now covariantly tracking the garbage collector lifetime, in
current Rust it is not possible to pass it into a function call together with an
exclusive holder of that same lifetime. This is the same old reason that
explains why Nova's code is currently filled to the brim with `.unbind()` and
`.bind(gc.nogc())` calls. Our hypothetical place wrapper system would need the
same system, and that system is fundamentally unsafe: no matter how careful we
are with our wrappers, they can be misused by creating or moving one in the
wrong context, and they must be unbound at the function interface.

## One is all, all is one - Handles are Zen

So, handles are covariant, they are invariant, and they are contravariant. They
are lifetimeless, they are unsafe in one way or another no matter what, and I
will need runtime validity checks to avoid going from merely unsafe territory
into the unsound wilderness. The question then is: what path to take? Let's
examine each option more time.

### Covariant handles

Our current situation: on the stack a `Handle` holds the garbage collector
lifetime covariantly, and on the managed heap it uses `'static` instead.
Benefits of this system are that a handles can be `Copy` and any copies made of
bound handles are still bound, retaining the main safety property of handles.

```rust
// Properly bound covariant handle.
let a = a.bind(gc.nogc());
// Copy is also properly bound.
let b = a;
perform_gc(gc.reborrow());
// TRUE NEGATIVE: a is use-after-free.
a.method();
// TRUE NEGATIVE: b is also use-after-free.
b.method();
```

The downsides are two: first the `.unbind()` and `.bind(gc.nogc())` calls needed
at function interfaces, and second the inability to assign a handle from the
stack into a slot on the heap without either unbinding the handle (to get a
`Handle<'static>`) or by transmuting the `&mut Handle<'static>` slot to match
the shorter `&mut Handle<'gc>` stack lifetime. The latter issue is admittedly
fairly well tamed by realising that in a future Nova the heap will not be
single-threaded and therefore `&mut Handle` references will become a thing of
the past: any question about assignability through references becomes moot.

```rust
let a = a.bind(gc.nogc());
// FALSE NEGATIVE: cannot move gc as it is still borrowed by a.
// FALSE NEGATIVE: cannot return Err variant from function as it borrows result
//                 of gc.reborrow().
let result = call(a, gc.reborrow())?;
// FALSE NEGATIVE: cannot borrow gc as immutable as it is also borrowed as
//                 mutable by result.
result.method(gc.nogc());
// TRUE POSITIVE: passing in a copy of a that is 'static.
// TRUE POSITIVE: returning Err variant that is 'static.
let result = call(a.unbind(), gc.reborrow()).unbind()?.bind(gc.nogc());
// TRUE POSITIVE: can borrow gc as immutable as result also borrows it as
//                immutable.
result.method(gc.nogc());

// Properly bound covariant handle.
let handle: Handle<'gc> = handle.bind(gc.nogc());
let slot: &mut Handle<'static> = heap.get_value_mut();
// FALSE NEGATIVE: cannot assign Handle<'gc> to &mut Handle<'static> as it does
//                 not live long enough.
*slot = handle;
// TRUE POSITIVE: can assign Handle<'static> to &mut Handle<'static>.
*slot = handle.unbind()
// TRUE POSITIVE: can assign Handle<'gc> to &mut Handle<'gc>;
*unsafe { core::mem::transmute(slot) } = handle;
```

The first downside might be mitigated in some future Rust, if a function becomes
capable of expressing something akin to borrow groups in its API. At that point
our JavaScript calls would take as parameters and return `Handle`s bound to a
shared borrow of the local garbage collector marker, removing the need for
unbinding and binding. Though, this would also need the `Reborrow` trait work
(that I am working on) to land as the compiler must be able to reason about
reborrowing `gc` so as to know that it does not need to worry about the
`gc.reborrow()` call already performing mutations. It also needs the Polonius
borrow checker work to land, as Polonius is needed for using the `?` operator
`Result<T, E>` where both `T` and `E` reborrow the same value and the Ok variant
wants to shrink its lifetime to the local function, while the Err variant wants
to expand it to rethrow it. of them wants to extend its lifetime while the other
wants to shrink it.

```rust
// TRUE POSITIVE: can reborrow gc even though it is still borrowed by a, as
//                `call` promises to invalidate `a` if `gc` is mutated.
// TRUE POSITIVE: returning Err variant can expand `'gc` lifetime to return
//                value type independently of Ok variant lifetime thanks to
//                Reborrow and Polonius.
let result = call(a, gc)?;
// TRUE POSITIVE: can borrow gc as immutable as `call` promises that it returns
//                result reborrowing `gc` as immutable.
result.method(gc);

// TRUE POSITIVE: method takes &self, lifetimes an internal consideration at
//                this point.
heap.write_value(handle);
```

At that point, the final downside of covariant handles would be the lack of
branding: nothing in the APIs would stop one from using a handle from one heap
with another.

```rust
let handle1 = heap1.get_handle(gc1);
// FALSE POSITIVE: nothing forbids mixing up any number of heaps and their
//                 handles together, but this is obviously not safe.
call(heap2, handle1, gc3);
```

### Invariant handles

With invariant handles we mostly live in the same world as with covariant
handles, except that we could now use unifying of the handle and garbage
collector lifetime as a safety guarantee that the values all indeed originate
from the same heap:

```rust
let handle1 = heap1.get_handle(gc1);
// TRUE NEGATIVE: mixing different brands; handle1 should have exactly the same
//                lifetime as a shared borrow of gc3.
call(heap2, handle1, gc3);
```

All of this is contingent on the mentioned Rust of the future and all of the
features within: `Reborrow` traits, Polonius borrow checker, and the as-of-yet
unknown way to indicate borrowing of parameters at function interface. For the
moment invariant handles would simply be an entirely unworkable pain, as even
`.unbind()?` would not work since or APIs return Err variants bound to the `'gc`
lifetime which obviously is not the same as `'static`.

### Contravariant handles

With contravariant handles we get all the pleasures and conveniences we could
ever want, today! It costs only most of the safety benefits we get from our
present covariant handles...

A copy of a properly bound contravariant handle is not properly bound:

```rust
// Properly bound contravariant handle.
bind!(let a = a, gc);
// But a copy is released from the bound!
let b = a;
perform_gc(gc.reborrow());
// TRUE NEGATIVE: a is use-after-free.
a.method();
// FALSE POSITIVE: b is also use-after-free.
b.method();
```

This is particularly painful with type conversions:

```rust
// Properly bound contravariant handle.
bind!(let a = a, gc);
// Whoops: copy is released from the bound!
let Ok(a) = Object::try_from(a) else { ... };
perform_gc(gc.reborrow());
// FALSE POSITIVE: a is use-after-free.
a.method();
```

But indeed binding, unbinding, and issues with heap lifetime assignments are
gone, just like are any guarantees about return type lifetimes:

```rust
bind!(let a = a, gc);
// TRUE POSITIVE: copy of a is released from bound and expands to call lifetime.
// TRUE POSITIVE: can return Err variant as its lifetime is based on
//                `gc.reborrow()`, which is necessarily shorter than our return
//                lifetime of `'gc`.
let result = call(a, gc.reborrow())?;
// TRUE POSITIVE: can borrow gc as immutable as result chooses an arbitrary
//                lifetime longer than `gc.reborrow()` result.
result.method(gc.nogc());
perform_gc(gc.reborrow());
// FALSE POSITIVE: result isn't bound properly bound.
result.method(gc.nogc());

// Fixing the above false positive requires binding the result.
bind!(let result = call(a, gc.reborrow())?, gc);
perform_gc(gc.reborrow());
// TRUE NEGATIVE: now result is properly bound and invalidates by GC.
result.method(gc.nogc());

// Properly bound contravariant handle.
bind!(let handle: Handle<'gc> = handle, gc);
let slot: &mut Handle<'static> = heap.get_value_mut();
// TRUE POSITIVE: can assign Handle<'gc> to &mut Handle<'static> as it has a
//                shorter lifetime.
*slot = handle;
```

As you can maybe see, the humongous issue here is that any assignment or copy of
a bound handle will always create an unbound handle: this is likely going to be
a hard thing to wrap one's head around. It is somewhat mitigated by the binding
rule of thumb being very simple: `bind!(let name = ...)` every `name` every
time. But even just an assignment `a = b` can apparently release `a` from being
bound if `b` has a short enough lifetime! So the rule of thumb isn't quite so
simple either.

Contravariant handles are definitely convenient, but they are a very sharp edge.
There is also some behind-the-scenes extra issues in that contravariant handles
seem to be very hard to use in generic code.

### Lifetimeless handles with wrappers

If I use a covariant `Local<'gc, Handle>` wrapper then I can leave lifetimes
well off of my handles and many things become quite simple. For example, the
above-mentioned issue with contravariant handles in generic code simple
disappears. The issue is fundamentally about `Handle<'_>` being generic over a
lifetime and me needing to produce a new `Handle` with a supertype lifetime of
the original: a subtype would be easy to produce by simply doing an assignment,
but a supertype needs a trait method, and a trait method on `Handle<'a>` cannot
produce `Self: 'b`. Instead it must produce a `Self::Of<'b>` using an associated
type `type Of<'l> = Handle<'l>`, but the compiler cannot know that `Self::Of` is
always equivalent to `Handle` and that leads to quite some issues. (Now that I
think about it, I could probably make that an associated type bound
elsewhere...)

With lifetimeless handles I would not need to bother with any of that, as within
my generic function defined over some handle trait `T`, I'd only be lifetime
generic over the lifetime of `Local`, but as `Local` is a concrete type it
becomes trivial to handle any lifetime trickery I need to do with it. In general,
generic code would become much easier to write.

But the downside here is that now handles are explicitly unprotected by any
lifetime binding whatsoever and due to the same issue plaguing covariant
handles, I would have to use unwrapped handles are the parameter and return
types:

```rust
// Properly wrapped handle.
let a: Local<Handle> = Local::new(handle, gc.nogc());
// Copy is still properly wrapped.
let b = a;
let result = Local::new(call(*a, gc.reborrow())?, gc.nogc());
// TRUE NEGATIVE: b is use-after-free.
b.method();
```

Note the `*a` at the call site: that is an explicit Deref operation. A
`Local<Handle>` would implement `Deref` with the target type being `Handle`,
enabling copying a `Handle` out of wrapper. The downside is that it is now very
easy to smuggle a handle past a garbage collection safepoint and get
use-after-free:

```rust
// Unwrapped handle.
let b: Handle = *a;
perform_gc(gc.reborrow());
// FALSE POSITIVE: b is use-after-free but nothing guards it.
let b = Local::new(b, gc.nogc());
```

Experience shows that especially people new to the idea of unrooted handles will
write code like this when it fixes a borrow checker error. An obvious
improvement here would be to make getting an unwrapped handle harder, but it
cannot be too hard because calling functions and returning values will always
need to do this unwrapping.

A further issue with wrapper types like this is that they make it harder to make
use of handles. Take for instance type checking in Nova: currently you can try
if a JavaScript Value is an Object by running the following code:

```rust
let Ok(a) = Object::try_from(a) else { ... };
```

With wrapped handles, this API would necessarily return an _unwrapped_ `Object`
handle which would then need to be wrapped into a `Local`: note how similar that
is to the contravariant handles case! Alternatively the call could be changed to
the following:

```rust
let Ok(a) = Local<Object>::try_from(a) else { ... };
```

Having used and contributed to both V8 and Deno's
[v8](https://crates.io/crates/v8) bindings, this admittedly looks very familiar
and snug in that sense (except that in V8 a `Local` is rooted, similar to
`Scoped<Object>` in Nova). Wrapper types are a familiar kind of trick that
programmers play on each other, so this is a really enthralling proposal. But
some parts of the API definitely do suffer: in Nova you can `match` on a handle
to see which variant it is and react accordingly, but that would not work for a
`Local<Handle>` because the wrapper stands in the way and would not have any
enum variants.

In our far-off future Rust with all the great new features, passing and
returning `Local<Handle>`s would become possible and then unwrapping of handles
would no longer really be all that necessary. But at that point wrapping of
handles would also no longer really be all that necessary in the first place. Of
course, this still doesn't do anything about branding which is yet another pain
point to resolve, but that is for later.

## What to do?

I do not know. The current covariant system is probably close to as safe as I
can make the system be, and it is quite convenient in how it allows me to just
think in terms of handles regardless of where they are located in. But the
covariant system also suffers from issues around passing around bound handles
that requires effectively lifetime transmutes to work around.

Contravariant handles would be massively more convenient but also much harder to
make sense of, and much less safe. Invariant handles would be massively
inconvenient to the point of being totally unusable right now, but they would
solve branding in the future. Wrapper types would be a very familiar looking way
of handling the issue, and in some sense would take a middle ground between
covariant and contravariant handles. They would also make writing generic code
much easier, but in the far-off future would possibly make themselves
meaningless.

I am very open to ideas both from the Nova community in particular, but also
from the wider Rust community in general. What do you think seems like the
reasonable choice for tracking the validity lifetime of unrooted handles? Or do
you think the whole effort is a waste of time, and I should've just worked with
only rooted values from the get go? Let me know on whatever messaging platform
you find me on!

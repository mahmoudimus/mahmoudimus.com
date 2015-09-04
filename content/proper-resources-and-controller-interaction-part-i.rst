Proper Resources and Controller Interaction When Modeling REST APIs - Part I
#############################################################################
:date: 2014-07-01
:author: Mahmoud
:tags: python, rest, apis
:excerpt: On properly modeling interactions between resources and controllers

When speaking traditionally about MVC and the current state of web frameworks,
I find that there's several cannons with differing opinions on how to structure
code.

From my experience building `Balanced`_ and a variety of HTTP service APIs, I've
finally had some time to jot down a few thoughts regarding the optimal ways
on structuring code to address several concerns that typically arise when
developing HTTP REST-adhering APIs.

What is a Resource?
-------------------

When developing any interaction over HTTP, a resource is essentially the "thing"
to operate on. Whether that operation is to view it, update it, etc - it
represents the target, atomic unit, or single item to operate on. This definition
serves as the foundation on which the rest of this article is built on.

How to locate a Resource?
---

A resource is typically identified and located through its resource
identifier. All resources can be identified and located via a
universal resource identifier (URL). If we're trying to build an HTTP
API, a resource is located and identified by its hypertext reference
(HREF).

Therefore, two perfectly acceptable identifiers and locators for
resources can be a URL or in the context of HTTP, an HREF.

What is the Single Responsibility of a Resource?
---

The single responsibility of the resource is to allow us to control the domain
it represents via normal HTTP interaction.

Therefore, a resource is responsible for mapping HTTP methods to resource
operations. This establishes the commonly established pattern::

  request -> do something -> response

A resource can therefore tell us about payloads it expects to receive and

OK, then what's a Controller?
-----------------------------

Concluding Thoughts
-------------------

Open questions taht are left here

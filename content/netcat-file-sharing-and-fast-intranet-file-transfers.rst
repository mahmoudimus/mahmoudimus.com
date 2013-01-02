I don't know why, but transferring files on a wireless network on a home computer is the worst experience I've ever encountered in modern computing. Every time I want to transfer a file, a plethora of obstacles occurs that make it a very unpleasant experience. I've encountered issues on all the popular operating systems: Mac OS X, Ubuntu, and Windows.

These issues may range widely, from where your target transfer destination computer isn't recognized on the network all the way to different types of operating systems with bullshit locked in protocols for recognizing other computers on your network (*cough* windows vista *cough*).

If you're reading this and thought to yourself, why not use rsync or scp? Well, I'll tell you why: because you need to create a user account for the recipient to connect to your machine or you have to physically walk to the other computer and initiate a remote copy by typing in your credentials when executing the (ssh|scp|rsync) command. How is this shit acceptable?

Surprisingly, there's a very simple way to transfer files between two computers on a network, netcat -- the network Swiss army knife. It simplifies file transfers and makes the whole process super simple. In fact, netcat is so useful, it ranks fourth out of the top 100 network security tools. It has tons of other uses outside of just file transferring, and this trick is simply just scratching the tip of the iceberg.

Here's a simple use case where netcat simplifies direct peer-to-peer LAN file-transfers. Imagine a home video called 'babies.first.steps.avi' that you want to transfer to another computer. Let's explicitly list the requirements to initiate a file transfer using netcat so that these steps are easier to understand conceptually.

babies.first.steps.avi is a 350MB file located on a computer called haskell
I want to copy babies.first.steps.avi to a computer called gauss

On haskell, I type in ifconfig at the command-line and find out Haskell's ip address is 192.168.1.130

That's all that's need to initiate the file transfer. Without having to deal with all associated bullshit of transferring files, just follow these instructions:

Here's the directory:

[bash]
[mahmoud@haskell:~/Movies]
% ll
total 716272
-r--r--r--  1 mahmoud  staff  366729226 Nov 20 15:29 babies.first.steps.avi
[/bash]

On haskell, I issue this command on the command-line:

[bash]
# 35500 is the port number
cat babies.first.steps.avi | netcat -l 0.0.0.0 35500
[/bash]

On gauss, I issue this command on the command-line:

[bash]
nc 192.168.1.130 35500 > babies.first.steps.avi
[/bash]

A few minutes later, babies.first.steps.avi is transferred successfully to gauss.

How Does Netcat Work?

Some further thoughts and conclusions?
There should exist a GUI over netcat for trivial file sharing for the masses. Some good solutions are something like Sendoid.

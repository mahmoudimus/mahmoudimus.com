/* Table-of-contents scroll-spy.

   The TOC markup and the heading ids are produced server-side by the `toc`
   plugin (see plugins/toc.py); this only highlights the section you're
   currently reading by toggling `.active` on the matching link. */

const TRIGGER = 120 // px below the viewport top counts as "current"

const initToc = () => {
  const toc = document.querySelector('.article-toc')
  if (!toc) return

  const headings = [] // [{ target, link }] in document order
  toc.querySelectorAll('a[href^="#"]').forEach((a) => {
    const id = decodeURIComponent(a.getAttribute('href').slice(1))
    const target = document.getElementById(id)
    if (target) headings.push({ target, link: a })
  })
  if (!headings.length) return

  let active = null
  const setActive = (link) => {
    if (link === active) return
    if (active) active.classList.remove('active')
    if (link) link.classList.add('active')
    active = link
  }

  const sync = () => {
    // The last heading whose top has scrolled above the trigger line is current;
    // before the first heading, highlight the first.
    let current = headings[0]
    for (const h of headings) {
      if (h.target.getBoundingClientRect().top < TRIGGER) current = h
    }
    setActive(current.link)
  }

  // IntersectionObserver wakes us on entry/exit; sync() does the actual pick.
  const observer = new IntersectionObserver(sync, {
    threshold: 0,
    rootMargin: '0px 0px -65% 0px',
  })
  headings.forEach((h) => observer.observe(h.target))
  window.addEventListener('scroll', sync, { passive: true })
  sync()
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initToc)
} else {
  initToc()
}

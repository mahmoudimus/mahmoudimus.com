/* Footnote popovers — progressive enhancement over cmark-gfm footnotes.

   cmark-gfm emits:
     <sup class="footnote-ref"><a href="#fn-1" id="fnref-1" data-footnote-ref>1</a></sup>
     <section class="footnotes"><ol><li id="fn-1"><p>… <a class="footnote-backref">↩</a></p></li></ol></section>

   We turn each ref's inner <a> into a popover trigger, build a popover from the
   matching <li>, position it with Floating UI, and hide the bottom list. The
   list stays in the DOM, so no-JS readers, crawlers and print still get it. */

import { computePosition, offset, flip, shift } from './vendor/floating-ui.dom.mjs'

const ACTIVE_REF = 'footnote-ref--active'
const ACTIVE_POP = 'footnote-popover--active'

const place = (anchor, popover) =>
  computePosition(anchor, popover, {
    placement: 'bottom-start',
    middleware: [offset(6), flip(), shift({ padding: 8 })],
  }).then(({ x, y }) => {
    Object.assign(popover.style, { left: `${x}px`, top: `${y}px` })
  })

const closeAll = (except) => {
  document.querySelectorAll('.' + ACTIVE_POP).forEach((pop) => {
    if (pop === except) return
    pop.classList.remove(ACTIVE_POP)
    pop.setAttribute('aria-hidden', 'true')
    if (pop._ref) {
      pop._ref.classList.remove(ACTIVE_REF)
      pop._ref.setAttribute('aria-expanded', 'false')
    }
  })
}

const toggle = (anchor, popover) => {
  const open = !popover.classList.contains(ACTIVE_POP)
  if (open) {
    closeAll(popover)
    place(anchor, popover)
  }
  anchor.classList.toggle(ACTIVE_REF, open)
  anchor.setAttribute('aria-expanded', String(open))
  popover.classList.toggle(ACTIVE_POP, open)
  popover.setAttribute('aria-hidden', String(!open))
}

export const initFootnotes = () => {
  const refs = document.querySelectorAll(
    'sup.footnote-ref > a[data-footnote-ref], a.footnote-ref'
  )
  if (!refs.length) return
  document.documentElement.classList.add('fn-js')

  refs.forEach((anchor) => {
    const id = decodeURIComponent((anchor.getAttribute('href') || '').split('#')[1] || '')
    const target = id && document.getElementById(id)
    if (!target) return

    anchor.classList.add('footnote-ref--interactive')
    // The ref sits inside <sup>; drop the superscript so the ••• marker sits
    // inline on the baseline, next to the text.
    anchor.closest('sup.footnote-ref')?.classList.add('footnote-ref--inline')
    anchor.textContent = '' // the ••• marker is drawn by CSS
    anchor.setAttribute('role', 'button')
    anchor.setAttribute('aria-label', 'Show footnote')
    anchor.setAttribute('aria-expanded', 'false')

    const popover = document.createElement('div')
    popover.className = 'footnote-popover'
    popover.setAttribute('role', 'note')
    popover.setAttribute('aria-hidden', 'true')
    popover.innerHTML = target.innerHTML
    popover.querySelector('.footnote-backref')?.remove()
    popover._ref = anchor
    document.body.appendChild(popover)

    anchor.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      toggle(anchor, popover)
    })
    // Clicks inside the popover (e.g. a link) must not dismiss it.
    popover.addEventListener('click', (e) => e.stopPropagation())
    // Keep an open popover anchored as the viewport changes.
    const reflow = () => {
      if (popover.classList.contains(ACTIVE_POP)) place(anchor, popover)
    }
    window.addEventListener('resize', reflow)
    window.addEventListener('scroll', reflow, { passive: true })
  })

  document.addEventListener('click', () => closeAll(null))
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAll(null)
  })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initFootnotes)
} else {
  initFootnotes()
}

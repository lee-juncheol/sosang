import { useLayoutEffect, useState } from 'react'

/** Slides one shared highlight under the pressed button of a segmented control instead of
 *  switching each button's background. The container gets the `segmented` class; the pill is
 *  its ::before, positioned from CSS variables set here. `key` is the selected value (and
 *  anything that changes button widths, such as the locale). */
export function useSegmentPill<T extends HTMLElement>(key: unknown) {
  // A callback ref, so a control that unmounts and comes back (view changes) is measured again.
  const [box, setBox] = useState<T | null>(null)
  useLayoutEffect(() => {
    if (!box) return
    const place = () => {
      const active = box.querySelector<HTMLElement>(':scope > [aria-pressed="true"]')
      if (!active || !active.offsetWidth) { box.classList.remove('pill-on'); return }
      box.style.setProperty('--pill-x', `${active.offsetLeft}px`)
      box.style.setProperty('--pill-y', `${active.offsetTop}px`)
      box.style.setProperty('--pill-w', `${active.offsetWidth}px`)
      box.style.setProperty('--pill-h', `${active.offsetHeight}px`)
      box.classList.add('pill-on')
    }
    place()
    // Animate only moves made after the first placement, not the jump from nothing.
    const frame = requestAnimationFrame(() => box.classList.add('pill-ready'))
    const observer = new ResizeObserver(place)
    observer.observe(box)
    for (const child of Array.from(box.children)) observer.observe(child)
    return () => { cancelAnimationFrame(frame); observer.disconnect() }
  }, [box, key])
  return setBox
}

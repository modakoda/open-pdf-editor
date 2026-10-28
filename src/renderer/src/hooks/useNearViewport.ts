/**
 * Tracks which keyed elements are within (or near) a scroll container's viewport using one
 * IntersectionObserver. Without IntersectionObserver (tests) every element counts as near.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

export function useNearViewport(
  rootRef: RefObject<HTMLElement | null>,
  rootMargin: string
): { near: ReadonlySet<string>; observe: (key: string, el: HTMLElement | null) => void } {
  const supported = typeof IntersectionObserver !== 'undefined'
  const [near, setNear] = useState<ReadonlySet<string>>(() => new Set())
  const elements = useRef(new Map<string, HTMLElement>())
  const observer = useRef<IntersectionObserver | null>(null)
  const pending = useRef(new Map<string, boolean>())
  const frame = useRef(0)

  const flush = useCallback(() => {
    frame.current = 0
    const changes = pending.current
    pending.current = new Map()
    setNear((prev) => {
      let changed = false
      const next = new Set(prev)
      for (const [key, isNear] of changes) {
        if (isNear && !next.has(key)) {
          next.add(key)
          changed = true
        } else if (!isNear && next.has(key)) {
          next.delete(key)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [])

  useEffect(() => {
    if (!supported || !rootRef.current) return
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const key = (entry.target as HTMLElement).dataset.nearKey
          if (key) pending.current.set(key, entry.isIntersecting)
        }
        if (!frame.current) frame.current = requestAnimationFrame(flush)
      },
      { root: rootRef.current, rootMargin }
    )
    observer.current = io
    for (const el of elements.current.values()) io.observe(el)
    return () => {
      io.disconnect()
      observer.current = null
      if (frame.current) cancelAnimationFrame(frame.current)
      frame.current = 0
    }
  }, [supported, rootRef, rootMargin, flush])

  const observe = useCallback(
    (key: string, el: HTMLElement | null) => {
      const prev = elements.current.get(key)
      if (prev === el) return
      if (prev) {
        observer.current?.unobserve(prev)
        elements.current.delete(key)
      }
      if (el) {
        el.dataset.nearKey = key
        elements.current.set(key, el)
        observer.current?.observe(el)
        if (!supported) setNear((s) => (s.has(key) ? s : new Set(s).add(key)))
      } else {
        pending.current.set(key, false)
        if (supported && !frame.current) frame.current = requestAnimationFrame(flush)
      }
    },
    [supported, flush]
  )

  return { near, observe }
}

import { useEffect } from 'react'

export function useWorkLoss(hasWork: boolean): void {
  useEffect(() => {
    if (!hasWork) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [hasWork])
}

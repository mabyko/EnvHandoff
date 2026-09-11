import type { ServerMessage } from '@envhandoff/protocol'
import { relayError } from './relay.ts'

export type LiveState = {
  status: 'connecting' | 'waiting' | 'peer' | 'sending' | 'transferred' | 'complete' | 'error'
  peerId: string
  verification: string
  expiresAt: number
  percent: number
  error: string
}
export const initialLiveState: LiveState = {
  status: 'connecting',
  peerId: '',
  verification: '',
  expiresAt: 0,
  percent: 0,
  error: '',
}

export function updateLive(state: LiveState, event: ServerMessage): LiveState {
  switch (event.type) {
    case 'ready':
      return { ...state, status: 'waiting', expiresAt: event.expiresAt }
    case 'peer':
      return { ...state, status: 'peer', peerId: event.peerId, verification: event.verification }
    case 'approved':
      return { ...state, status: 'sending' }
    case 'progress':
      return { ...state, percent: Math.floor((event.offset / event.total) * 100) }
    case 'transferred':
      return { ...state, status: 'transferred', percent: 100 }
    case 'complete':
      return { ...state, status: 'complete' }
    case 'error':
      return { ...state, status: 'error', error: relayError(event.reason) }
  }
}

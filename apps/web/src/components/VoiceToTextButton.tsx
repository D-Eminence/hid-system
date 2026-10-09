import React, { useEffect, useRef, useState } from 'react'
import { Button, showToast } from './ui'

interface SpeechRecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}

interface SpeechRecognitionEventLike {
  resultIndex: number
  results: ArrayLike<ArrayLike<{ transcript: string }>>
}

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionLike
    webkitSpeechRecognition?: new () => SpeechRecognitionLike
  }
}

export function VoiceToTextButton({
  onTranscript,
  label = 'Voice to text',
}: {
  onTranscript: (text: string) => void
  label?: string
}) {
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const [listening, setListening] = useState(false)

  function getFriendlyVoiceError(error: string) {
    const normalized = error.toLowerCase()
    if (normalized.includes('request could not be completed with those details')) {
      return 'Voice capture could not start right now. Please try again.'
    }
    if (normalized.includes('not-allowed') || normalized.includes('service-not-allowed')) {
      return 'Microphone access is blocked. Allow it in your browser settings, then try again.'
    }
    if (normalized.includes('permission denied') || normalized.includes('not allowed')) {
      return 'Microphone access is blocked. Allow it in your browser settings, then try again.'
    }
    if (normalized.includes('audio-capture')) {
      return 'No microphone was detected on this device.'
    }
    if (normalized.includes('network')) {
      return 'Voice capture could not connect right now. Try again in a moment.'
    }
    if (normalized.includes('no-speech')) {
      return 'We did not hear any speech. Please try again.'
    }
    if (normalized.includes('aborted')) {
      return 'Voice capture was stopped before it could finish.'
    }
    return 'Voice capture could not start right now.'
  }

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop()
    }
  }, [])

  async function startListening() {
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition
    if (!Recognition) {
      showToast('Voice-to-text is not supported in this browser', 'error')
      return
    }

    if (!window.isSecureContext) {
      showToast('Voice capture requires a secure connection (HTTPS).', 'error')
      return
    }

    if (navigator.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        stream.getTracks().forEach(track => track.stop())
      } catch (error) {
        const permissionMessage = error instanceof Error ? error.message : 'Microphone access is blocked.'
        showToast(permissionMessage.toLowerCase().includes('denied') || permissionMessage.toLowerCase().includes('allowed')
          ? 'Microphone access is blocked. Allow it in your browser settings, then try again.'
          : 'Voice capture could not start right now. Please try again.', 'error')
        return
      }
    }

    const recognition = new Recognition()
    recognition.continuous = true
    recognition.interimResults = false
    recognition.lang = 'en-US'
    recognition.onresult = event => {
      const transcript = Array.from(event.results)
        .slice(event.resultIndex)
        .flatMap(result => Array.from(result))
        .map(item => item.transcript.trim())
        .filter(Boolean)
        .join(' ')

      if (transcript) onTranscript(transcript)
    }
    recognition.onerror = event => {
      setListening(false)
      showToast(getFriendlyVoiceError(event.error), 'error')
    }
    recognition.onend = () => setListening(false)

    try {
      recognition.start()
      recognitionRef.current = recognition
      setListening(true)
      showToast('Voice capture started', 'info')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Voice capture could not start.'
      showToast(getFriendlyVoiceError(message), 'error')
    }
  }

  function stopListening() {
    recognitionRef.current?.stop()
    setListening(false)
    showToast('Voice capture stopped', 'info')
  }

  return (
    <Button variant={listening ? 'danger' : 'secondary'} onClick={listening ? stopListening : startListening}>
      {listening ? 'Stop listening' : label}
    </Button>
  )
}

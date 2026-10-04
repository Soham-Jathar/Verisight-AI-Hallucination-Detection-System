import { useEffect, useMemo, useRef, useState } from 'react'
import { deleteSavedConversation, loadSavedConversations, saveConversation } from './lib/conversations'
import { isSupabaseConfigured, supabase } from './lib/supabase'

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

const statusLabel = {
  supported: 'Supported',
  uncertain: 'Needs review',
  unsupported: 'Unsupported',
}

const providerLabel = {
  gemini: 'Gemini',
  groq: 'Groq',
}

// Keep the product UI focused on the two supported user-facing LLMs and their
// comparison mode. Research baselines and provider experiments remain internal.
const visibleProviderIds = new Set(['gemini', 'groq', 'compare'])

const passwordRules = [
  ['At least 8 characters', (value) => value.length >= 8],
  ['One uppercase letter', (value) => /[A-Z]/.test(value)],
  ['One lowercase letter', (value) => /[a-z]/.test(value)],
  ['One number', (value) => /\d/.test(value)],
  ['One special character', (value) => /[^A-Za-z0-9]/.test(value)],
]

function strongPassword(value) {
  return passwordRules.every(([, test]) => test(value))
}

async function readApiPayload(response) {
  const body = await response.text()
  if (!body) return {}
  try { return JSON.parse(body) } catch { return { detail: body } }
}

function apiErrorMessage(payload, fallback) {
  const detail = payload?.detail ?? payload?.message ?? payload?.error
  if (typeof detail === 'string' && detail.trim()) return detail
  if (Array.isArray(detail)) {
    const messages = detail.map((item) => item?.msg ?? item?.message ?? '').filter(Boolean)
    if (messages.length) return messages.join('. ')
  }
  if (detail && typeof detail === 'object') {
    if (typeof detail.message === 'string') return detail.message
    if (typeof detail.error?.message === 'string') return detail.error.message
  }
  return fallback
}

function Citation({ source, index }) {
  const label = source.source_quality ?? 'Web source'
  const content = <>{`[${index + 1}] ${source.title}`}<small className="source-quality">{label}</small></>
  return source.url.startsWith('document://')
    ? <em>{content}</em>
    : <a href={source.url} target="_blank" rel="noreferrer">{content}</a>
}

const evidenceStopWords = new Set(['about', 'after', 'against', 'also', 'among', 'because', 'before', 'being', 'could', 'first', 'from', 'into', 'more', 'other', 'their', 'there', 'these', 'they', 'this', 'through', 'under', 'were', 'what', 'when', 'which', 'with', 'would'])

function evidenceTerms(claim) {
  return [...new Set((claim.toLowerCase().match(/[a-z0-9+#]{4,}/g) ?? []).filter((term) => !evidenceStopWords.has(term)))].slice(0, 12)
}

function HighlightedEvidence({ claim, text }) {
  const terms = evidenceTerms(claim)
  if (!terms.length || !text) return text
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const pattern = new RegExp(`(${escaped})`, 'gi')
  return text.split(pattern).map((part, index) => terms.includes(part.toLowerCase())
    ? <mark key={`${part}-${index}`}>{part}</mark>
    : part)
}

function createConversation() {
  return { id: crypto.randomUUID(), title: 'New conversation', messages: [] }
}

function AuthDialog({ open, recoveryRequested, onClose, onAuthenticated, onRecoveryHandled }) {
  const [mode, setMode] = useState('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordVisible, setPasswordVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (recoveryRequested) {
      setMode('reset')
      setMessage('Choose a new password for your account.')
      setPassword('')
      setConfirmPassword('')
      setPasswordVisible(false)
    }
  }, [recoveryRequested])

  useEffect(() => {
    if (!open) {
      setMode('signin')
      setEmail('')
      setPassword('')
      setConfirmPassword('')
      setMessage('')
      setPasswordVisible(false)
    }
  }, [open])

  if (!open) return null

  async function submit(event) {
    event.preventDefault()
    if (!supabase) return
    if ((mode === 'signup' || mode === 'reset') && !strongPassword(password)) {
      setMessage('Use at least 8 characters, including uppercase, lowercase, a number, and a special character.')
      return
    }
    if (mode === 'reset' && password !== confirmPassword) {
      setMessage('The two passwords do not match.')
      return
    }
    setBusy(true)
    setMessage('')
    let result
    if (mode === 'signin') result = await supabase.auth.signInWithPassword({ email, password })
    else if (mode === 'signup') result = await supabase.auth.signUp({ email, password })
    else if (mode === 'forgot') {
      result = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin })
    } else {
      result = await supabase.auth.updateUser({ password })
    }
    setBusy(false)
    if (result.error) { setMessage(result.error.message); return }
    if (mode === 'forgot') {
      setMessage('If an account exists for that email, a password-reset link has been sent. Check your inbox and spam folder.')
      return
    }
    if (mode === 'reset') {
      window.history.replaceState({}, document.title, window.location.pathname)
      onRecoveryHandled()
      setMessage('Password updated. You are signed in.')
      return
    }
    if (mode === 'signup' && !result.data.session) {
      setMessage('Account created. Check your email to confirm it, then sign in.')
      return
    }
    onAuthenticated()
  }

  return <div className="auth-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="auth-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-title" onMouseDown={(event) => event.stopPropagation()}>
      <button className="auth-close" type="button" onClick={onClose} aria-label="Close">×</button>
      <p>VERISIGHT ACCOUNT</p><h2 id="auth-title">{mode === 'signin' ? 'Save your conversations' : mode === 'signup' ? 'Create an account' : mode === 'forgot' ? 'Reset your password' : 'Choose a new password'}</h2>
      <span>{mode === 'signin' ? 'Sign in to keep your verification history across devices.' : mode === 'signup' ? 'Create a free account to save your verification history.' : mode === 'forgot' ? 'Enter your account email and we will send a secure reset link.' : 'Use a strong password to secure your VeriSight account.'}</span>
      <form onSubmit={submit}>
        {mode !== 'reset' && <label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" /></label>}
        {mode !== 'forgot' && <label>{mode === 'reset' ? 'New password' : 'Password'}
          <span className="password-field">
            <input type={passwordVisible ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} required minLength={mode === 'signup' || mode === 'reset' ? 8 : undefined} autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} aria-describedby={mode === 'signup' || mode === 'reset' ? 'password-requirements' : undefined} />
            <button className="password-visibility" type="button" onClick={() => setPasswordVisible((visible) => !visible)} aria-label={passwordVisible ? 'Hide password' : 'Show password'} aria-pressed={passwordVisible}>{passwordVisible ? 'Hide' : 'Show'}</button>
          </span>
        </label>}
        {mode === 'reset' && <label>Confirm new password
          <input type={passwordVisible ? 'text' : 'password'} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required minLength="8" autoComplete="new-password" />
        </label>}
        {(mode === 'signup' || mode === 'reset') && <ul className="password-requirements" id="password-requirements" aria-label="Password requirements">
          {passwordRules.map(([label, test]) => <li key={label} className={test(password) ? 'met' : ''}>{test(password) ? '✓' : '○'} {label}</li>)}
        </ul>}
        <button type="submit" disabled={busy}>{busy ? 'Please wait...' : mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : mode === 'forgot' ? 'Send reset link' : 'Update password'}</button>
      </form>
      {message && <small className="auth-message">{message}</small>}
      {mode === 'signin' && <button className="auth-switch auth-forgot" type="button" onClick={() => { setMode('forgot'); setMessage(''); setPassword(''); setPasswordVisible(false) }}>Forgot password?</button>}
      {mode !== 'reset' && <button className="auth-switch" type="button" onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setMessage(''); setPassword(''); setConfirmPassword(''); setPasswordVisible(false) }}>{mode === 'signin' ? 'Need an account? Sign up' : 'Already have an account? Sign in'}</button>}
    </section>
  </div>
}

function VerificationCard({ result, feedback = {}, onFeedback }) {
  const [expandedClaim, setExpandedClaim] = useState(null)
  if (!result?.claims?.length) return null
  const reliability = result.reliability_score == null ? null : Math.round(result.reliability_score * 100)
  const uncertainty = result.uncertainty_score == null ? null : Math.round(result.uncertainty_score * 100)
  const citedUrls = new Set(result.claims.flatMap((claim) => (claim.citations ?? []).map((source) => source.url)))
  const otherSources = (result.evidence ?? []).filter((source) => !citedUrls.has(source.url))

  return <details className="verification-card">
    <summary><span className="verification-dot"></span>{reliability === null ? 'Verification unavailable' : 'Verification available'}<strong>{reliability === null ? 'Not verified' : `${reliability}% reliable`}{uncertainty !== null ? ` · ${uncertainty}% uncertainty` : ''}</strong></summary>
    <div className="verification-content">
      <p className="verification-summary">{result.message}</p>
      <div className="claim-list">
        {result.claims.map((claim, index) => <article className={`claim ${expandedClaim === index ? 'expanded' : ''}`} key={`${claim.claim}-${index}`}>
          <span className={`claim-dot ${claim.status}`}></span>
          <div><b>{claim.claim}</b><p>{statusLabel[claim.status]} · {Math.round(claim.confidence * 100)}% confidence</p><small>{claim.rationale}</small>
            {(claim.evidence_quality != null || claim.source_agreement != null) && <small>Evidence quality: {Math.round((claim.evidence_quality ?? 0) * 100)}% · Source agreement: {Math.round((claim.source_agreement ?? 0) * 100)}%</small>}
            {claim.citations?.length > 0 && <><div className="claim-citations"><span>Evidence</span>{claim.citations.map((source, citationIndex) => <Citation key={`${source.url}-${citationIndex}`} source={source} index={citationIndex} />)}</div>
              <button className="evidence-toggle" type="button" onClick={() => setExpandedClaim((current) => current === index ? null : index)}>{expandedClaim === index ? 'Hide matched evidence' : 'Show matched evidence'}</button>
              {expandedClaim === index && <div className="evidence-excerpts" aria-label={`Evidence excerpts for claim ${index + 1}`}>
                {claim.citations.map((source, citationIndex) => <figure key={`${source.url}-${citationIndex}`}><figcaption>{source.title}</figcaption><blockquote><HighlightedEvidence claim={claim.claim} text={source.snippet} /></blockquote></figure>)}
              </div>}
            </>}
            {onFeedback && <div className="claim-feedback"><span>Was this verification useful?</span><button type="button" className={feedback[index] === 'helpful' ? 'selected' : ''} onClick={() => onFeedback(index, 'helpful')} aria-pressed={feedback[index] === 'helpful'}>Helpful</button><button type="button" className={feedback[index] === 'needs-review' ? 'selected' : ''} onClick={() => onFeedback(index, 'needs-review')} aria-pressed={feedback[index] === 'needs-review'}>Needs correction</button></div>}
          </div>
        </article>)}
      </div>
      {otherSources.length > 0 && <div className="citations"><span>Other sources</span>
        {otherSources.map((source, index) => <Citation key={`${source.url}-${index}`} source={source} index={index} />)}
      </div>}
    </div>
  </details>
}

function CorrectionCard({ correction }) {
  if (!correction?.answer) return null
  return <section className="correction-card">
    <p className="correction-label">Evidence-grounded correction</p>
    <p className="correction-answer">{correction.answer}</p>
    {correction.citations?.length > 0 && <div className="citations correction-citations"><span>Citations</span>
      {correction.citations.map((source, index) => <Citation key={`${source.url}-${index}`} source={source} index={index} />)}
    </div>}
  </section>
}

function ComparisonCard({ comparisons }) {
  if (!comparisons || comparisons.length < 2) return null
  return <section className="comparison-card">
    <p className="comparison-label">Model comparison</p>
    <div className="comparison-grid">
      {comparisons.map((item) => {
        const reliability = item.reliability_score == null ? null : Math.round(item.reliability_score * 100)
        const supported = item.claims?.filter((claim) => claim.status === 'supported').length ?? 0
        return <article className="comparison-model" key={item.provider}>
          <header><strong>{providerLabel[item.provider] ?? item.provider}</strong><span>{reliability === null ? 'Not verified' : `${reliability}% reliable`}</span></header>
          <small>{item.model}</small>
          <p>{item.answer}</p>
          <em>{supported}/{item.claims?.length ?? 0} claims supported</em>
        </article>
      })}
    </div>
  </section>
}

function MessageBubble({ message, onFeedback }) {
  if (message.role === 'user') return <article className="message user-message"><p>{message.content}</p></article>
  if (message.pending) return <article className="message assistant-message loading-message"><span className="assistant-avatar">V</span><div><p>Generating and checking sources<span className="typing-dots">...</span></p></div></article>
  return <article className="message assistant-message"><span className="assistant-avatar">V</span><div className="assistant-copy"><p>{message.content}</p>{message.model && <small>{message.model}</small>}<ComparisonCard comparisons={message.verification?.comparisons} /><CorrectionCard correction={message.verification?.correction} /><VerificationCard result={message.verification} feedback={message.feedback} onFeedback={onFeedback} /></div></article>
}

function App() {
  const [conversations, setConversations] = useState(() => [createConversation()])
  const [activeId, setActiveId] = useState(() => conversations?.[0]?.id)
  const [draft, setDraft] = useState('')
  const [provider, setProvider] = useState('gemini')
  const [providers, setProviders] = useState([])
  const [apiStatus, setApiStatus] = useState('checking')
  const [verifyEnabled, setVerifyEnabled] = useState(true)
  const [uncertaintyEnabled, setUncertaintyEnabled] = useState(false)
  const [evidenceMode, setEvidenceMode] = useState('web')
  const [document, setDocument] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [listening, setListening] = useState(false)
  const [inputMenuOpen, setInputMenuOpen] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [user, setUser] = useState(null)
  const [authOpen, setAuthOpen] = useState(false)
  const [passwordRecoveryOpen, setPasswordRecoveryOpen] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [renamingId, setRenamingId] = useState(null)
  const [renameDraft, setRenameDraft] = useState('')
  const pdfInputRef = useRef(null)
  const imageInputRef = useRef(null)
  const inputPickerRef = useRef(null)
  const recognitionRef = useRef(null)

  useEffect(() => {
    if (!inputMenuOpen) return undefined
    function closeOnOutsideClick(event) {
      if (!inputPickerRef.current?.contains(event.target)) setInputMenuOpen(false)
    }
    function closeOnEscape(event) {
      if (event.key === 'Escape') setInputMenuOpen(false)
    }
    window.document.addEventListener('pointerdown', closeOnOutsideClick)
    window.document.addEventListener('keydown', closeOnEscape)
    return () => {
      window.document.removeEventListener('pointerdown', closeOnOutsideClick)
      window.document.removeEventListener('keydown', closeOnEscape)
    }
  }, [inputMenuOpen])

  useEffect(() => {
    let cancelled = false

    async function loadSetup() {
      // Render's free web services can take time to wake after inactivity. A
      // one-off check would leave the UI falsely marked offline even though
      // the API becomes available seconds later.
      const retryDelays = [0, 3000, 6000, 9000, 12000, 15000]

      for (const delay of retryDelays) {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
        if (cancelled) return

        try {
          const [healthResponse, providersResponse] = await Promise.all([fetch(`${API_URL}/health`), fetch(`${API_URL}/api/providers`)])
          if (!healthResponse.ok || !providersResponse.ok) throw new Error('Unavailable')
          const providerData = await providersResponse.json()
          const visibleProviders = providerData.filter((item) => visibleProviderIds.has(item.id))
          if (cancelled) return
          setProviders(visibleProviders)
          const firstConfigured = visibleProviders.find((item) => item.id === 'gemini' && item.configured)
            ?? visibleProviders.find((item) => item.id === 'groq' && item.configured)
            ?? visibleProviders.find((item) => item.id === 'compare' && item.configured)
          if (firstConfigured) setProvider(firstConfigured.id)
          setApiStatus('online')
          return
        } catch {
          // Try again while the free backend is starting.
        }
      }

      if (!cancelled) setApiStatus('offline')
    }
    loadSetup()
    return () => {
      cancelled = true
      recognitionRef.current?.stop()
    }
  }, [])

  useEffect(() => {
    if (!supabase) return undefined
    let mounted = true
    supabase.auth.getUser().then(({ data }) => {
      if (mounted) setUser(data.user ?? null)
    })
    const { data: subscription } = supabase.auth.onAuthStateChange((event, session) => {
      if (mounted) setUser(session?.user ?? null)
      if (mounted && event === 'PASSWORD_RECOVERY') {
        setPasswordRecoveryOpen(true)
        setAuthOpen(true)
      }
    })
    return () => { mounted = false; subscription.subscription.unsubscribe() }
  }, [])

  useEffect(() => {
    if (!user) return
    let mounted = true
    async function restoreHistory() {
      setHistoryLoading(true)
      try {
        const saved = await loadSavedConversations(user.id)
        if (!mounted || !saved.length) return
        setConversations(saved)
        setActiveId(saved[0].id)
      } catch {
        if (mounted) setError('Your saved history could not be loaded.')
      } finally {
        if (mounted) setHistoryLoading(false)
      }
    }
    restoreHistory()
    return () => { mounted = false }
  }, [user])

  const activeConversation = useMemo(() => conversations.find((conversation) => conversation.id === activeId) ?? conversations[0], [activeId, conversations])

  function startNewChat() {
    const conversation = createConversation()
    setConversations((current) => [conversation, ...current])
    setActiveId(conversation.id)
    setDraft('')
    setError('')
  }

  function startRename(conversation) {
    setRenamingId(conversation.id)
    setRenameDraft(conversation.title)
    setError('')
  }

  function cancelRename() {
    setRenamingId(null)
    setRenameDraft('')
  }

  async function renameConversation(conversation) {
    const title = renameDraft.trim().slice(0, 80)
    if (!title) {
      setError('Chat names cannot be empty.')
      return
    }

    const renamedConversation = { ...conversation, title }
    try {
      if (user) await saveConversation(renamedConversation, user.id)
      setConversations((current) => current.map((item) => item.id === conversation.id ? renamedConversation : item))
      cancelRename()
      setError('')
    } catch {
      setError('The chat could not be renamed. Please try again.')
    }
  }

  async function deleteConversation(conversation) {
    const confirmed = window.confirm(`Delete “${conversation.title}”? This cannot be undone.`)
    if (!confirmed) return

    try {
      if (user) await deleteSavedConversation(conversation.id, user.id)
      const remaining = conversations.filter((item) => item.id !== conversation.id)
      const nextConversations = remaining.length ? remaining : [createConversation()]
      setConversations(nextConversations)
      if (activeId === conversation.id) setActiveId(nextConversations[0].id)
      if (renamingId === conversation.id) cancelRename()
      setError('')
    } catch {
      setError('The chat could not be deleted. Please try again.')
    }
  }

  async function persistConversation(conversation) {
    if (!user) return
    try {
      await saveConversation(conversation, user.id)
    } catch {
      setError('The reply was generated, but the conversation could not be saved.')
    }
  }

  function openAuth() {
    if (!isSupabaseConfigured) {
      setError('Saved history needs Supabase configuration before sign-in can be enabled.')
      return
    }
    setPasswordRecoveryOpen(false)
    setAuthOpen(true)
  }

  async function signOut() {
    await supabase?.auth.signOut()
    setUser(null)
    const conversation = createConversation()
    setConversations([conversation])
    setActiveId(conversation.id)
  }

  async function uploadAttachment(event, endpoint, nextMode, fallbackMessage) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setUploading(true)
    setError('')
    try {
      const formData = new FormData()
      formData.append('file', file)
      const response = await fetch(`${API_URL}${endpoint}`, { method: 'POST', body: formData })
      const payload = await readApiPayload(response)
      if (!response.ok) throw new Error(apiErrorMessage(payload, fallbackMessage))
      setDocument(payload)
      setEvidenceMode(nextMode)
    } catch (uploadError) { setError(uploadError.message) } finally { setUploading(false) }
  }

  function recordClaimFeedback(messageId, claimIndex, value) {
    if (!activeConversation) return
    const conversation = {
      ...activeConversation,
      messages: activeConversation.messages.map((message) => {
        if (message.id !== messageId) return message
        const current = message.feedback?.[claimIndex]
        const feedback = { ...(message.feedback ?? {}) }
        if (current === value) delete feedback[claimIndex]
        else feedback[claimIndex] = value
        return { ...message, feedback }
      }),
    }
    setConversations((current) => current.map((item) => item.id === conversation.id ? conversation : item))
    void persistConversation(conversation)
  }

  function startListening() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!Recognition) { setError('Speech-to-text is not supported in this browser. Use Chrome or Edge.'); return }
    if (listening) { recognitionRef.current?.stop(); return }
    const recognition = new Recognition()
    recognition.lang = 'en-US'
    recognition.interimResults = true
    recognition.continuous = false
    recognition.onstart = () => { setListening(true); setError('') }
    recognition.onresult = (event) => {
      let transcript = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) transcript += event.results[index][0].transcript
      setDraft((current) => `${current}${current && !current.endsWith(' ') ? ' ' : ''}${transcript}`)
    }
    recognition.onerror = (event) => { setError(event.error === 'not-allowed' ? 'Microphone access was blocked. Allow it in your browser and try again.' : 'Voice transcription could not start.') }
    recognition.onend = () => setListening(false)
    recognitionRef.current = recognition
    recognition.start()
  }

  function chooseInput(action) {
    setInputMenuOpen(false)
    if (action === 'pdf') pdfInputRef.current?.click()
    if (action === 'image') imageInputRef.current?.click()
    if (action === 'voice') startListening()
  }

  function handleComposerKeyDown(event) {
    if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (!loading && !uploading && apiStatus === 'online' && draft.trim().length >= 3) {
      event.currentTarget.form?.requestSubmit()
    }
  }

  async function handleSubmit(event) {
    event.preventDefault()
    const question = draft.trim()
    if (question.length < 3 || loading || uploading || apiStatus !== 'online' || !activeConversation) return
    if ((evidenceMode === 'document' || evidenceMode === 'image' || evidenceMode === 'hybrid') && !document) { setError('Attach a PDF or image before using its evidence.'); return }

    const conversationId = activeConversation.id
    const userMessage = { id: crypto.randomUUID(), role: 'user', content: question }
    const pendingMessage = { id: crypto.randomUUID(), role: 'assistant', pending: true }
    // The backend intentionally keeps a compact context window. Preserve the
    // newest exchanges so long chat histories never exceed its validation limit.
    const history = activeConversation.messages
      .slice(-12)
      .map(({ role, content }) => ({ role, content }))
    setConversations((current) => current.map((conversation) => conversation.id === conversationId ? { ...conversation, title: conversation.messages.length === 0 ? question.slice(0, 42) : conversation.title, messages: [...conversation.messages, userMessage, pendingMessage] } : conversation))
    setDraft('')
    setLoading(true)
    setError('')
    try {
      const response = await fetch(`${API_URL}/api/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, provider, mode: evidenceMode, verify: verifyEnabled, measure_uncertainty: uncertaintyEnabled, history, document_id: document?.id ?? null }) })
      const payload = await readApiPayload(response)
      if (!response.ok) throw new Error(apiErrorMessage(payload, 'The analysis request failed.'))
      const assistantMessage = { id: crypto.randomUUID(), role: 'assistant', content: payload.answer ?? 'I could not generate an answer.', model: payload.model, verification: verifyEnabled ? payload : null }
      const completedConversation = {
        ...activeConversation,
        title: activeConversation.messages.length === 0 ? question.slice(0, 42) : activeConversation.title,
        messages: [...activeConversation.messages, userMessage, assistantMessage],
      }
      setConversations((current) => current.map((conversation) => conversation.id === conversationId ? completedConversation : conversation))
      void persistConversation(completedConversation)
    } catch (requestError) {
      setConversations((current) => current.map((conversation) => conversation.id === conversationId ? { ...conversation, messages: conversation.messages.filter((message) => message.id !== pendingMessage.id) } : conversation))
      setError(requestError instanceof Error ? requestError.message : 'The analysis request failed.')
    } finally { setLoading(false) }
  }

  return <main className="chat-app">
    <aside className="sidebar">
      <a className="brand" href="#top"><span className="brand-mark">V</span><span>VeriSight</span></a>
      <button className="new-chat" type="button" onClick={startNewChat}>+ New chat</button>
      <div className="account-panel sidebar-account">{user
        ? <><strong title={user.email}>{user.email}</strong><button type="button" onClick={signOut}>Sign out</button></>
        : <button type="button" onClick={openAuth}>{isSupabaseConfigured ? 'Sign in to save chats' : 'Configure saved history'}</button>}</div>
      <div className="history-heading"><span>History</span><small>{historyLoading ? 'Loading...' : user ? 'Saved' : 'This session'}</small></div>
      <nav className="chat-history" aria-label="Chat history">{conversations.map((conversation) => <div className="history-row" key={conversation.id}>
        {user && renamingId === conversation.id
          ? <form className="rename-form" onSubmit={(event) => { event.preventDefault(); void renameConversation(conversation) }}>
            <input value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} maxLength="80" autoFocus aria-label="New chat name" onKeyDown={(event) => { if (event.key === 'Escape') cancelRename() }} />
            <button type="submit">Save</button><button type="button" onClick={cancelRename}>Cancel</button>
          </form>
          : <><button type="button" className={conversation.id === activeConversation?.id ? 'history-item active' : 'history-item'} onClick={() => setActiveId(conversation.id)}><span>{conversation.title}</span><small>{conversation.messages.length ? `${Math.ceil(conversation.messages.length / 2)} message${conversation.messages.length > 2 ? 's' : ''}` : 'Empty'}</small></button>
            {user && <div className="history-actions">
              <button type="button" className="history-action" onClick={() => startRename(conversation)} aria-label={`Rename ${conversation.title}`} title="Rename chat">Rename</button>
              <button type="button" className="history-action delete" onClick={() => deleteConversation(conversation)} aria-label={`Delete ${conversation.title}`} title="Delete chat">Delete</button>
            </div>}</>}
      </div>)}</nav>
      <div className="sidebar-footer">
        <span className={`api-status ${apiStatus}`}><i></i> API {apiStatus}</span>
        <p>Use web, PDF, or both as verification evidence.</p>
      </div>
    </aside>
    <section className="chat-panel" id="top">
      <header className="chat-header">
        <div><p>AI HALLUCINATION DETECTION</p><h1>{activeConversation?.title ?? 'New conversation'}</h1></div>
        <div className="chat-controls">
          <label className="provider-select"><span>Model</span><select value={provider} onChange={(event) => setProvider(event.target.value)}>{providers.map((item) => <option key={item.id} value={item.id} disabled={!item.configured}>{item.label}{item.configured ? '' : ' (add key)'}</option>)}</select></label>
          <label className="provider-select"><span>Evidence</span><select value={evidenceMode} onChange={(event) => setEvidenceMode(event.target.value)}><option value="web">Web</option><option value="document" disabled={!document || document.kind !== 'pdf'}>PDF</option><option value="image" disabled={!document || document.kind !== 'image'}>Image text</option><option value="hybrid" disabled={!document}>Hybrid</option></select></label>
          <label className="verify-toggle"><input type="checkbox" checked={verifyEnabled} onChange={(event) => setVerifyEnabled(event.target.checked)} /><span></span>Verify</label>
          <label className="verify-toggle"><input type="checkbox" checked={uncertaintyEnabled} onChange={(event) => setUncertaintyEnabled(event.target.checked)} /><span></span>Uncertainty</label>
        </div>
      </header>
      <section className="message-thread" aria-live="polite">
        {!activeConversation?.messages.length && <div className="welcome-card"><span className="assistant-avatar large">V</span><div><h2>What would you like to know?</h2><p>Ask by typing or voice. Attach a PDF or text-containing image to verify answers against its contents.</p><div className="suggestions"><button type="button" onClick={() => setDraft('Who created the Python programming language?')}>Who created Python?</button><button type="button" onClick={() => setDraft('Explain quantum computing in simple terms.')}>Explain quantum computing</button></div></div></div>}
        {activeConversation?.messages.map((message) => <MessageBubble key={message.id} message={message} onFeedback={(claimIndex, value) => recordClaimFeedback(message.id, claimIndex, value)} />)}
      </section>
      <form className="composer" onSubmit={handleSubmit}>
        {document && <div className="document-chip"><span>{document.kind === 'image' ? 'Image' : 'PDF'}: {document.filename} ({document.pages} page{document.pages === 1 ? '' : 's'}{document.ocr_used ? ' · OCR text extracted' : ''})</span><button type="button" onClick={() => { setDocument(null); setEvidenceMode('web') }} aria-label="Remove attachment">×</button></div>}
        <div className="composer-row">
          <input ref={pdfInputRef} type="file" accept="application/pdf" hidden onChange={(event) => uploadAttachment(event, '/api/documents', 'document', 'PDF upload failed.')} />
          <input ref={imageInputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => uploadAttachment(event, '/api/images', 'image', 'Image upload failed.')} />
          <div className="input-picker" ref={inputPickerRef}>
            <button className={`input-picker-trigger ${listening ? 'listening' : ''}`} type="button" aria-label="Choose input type" aria-expanded={inputMenuOpen} aria-controls="input-options" onClick={() => setInputMenuOpen((open) => !open)} disabled={uploading || loading} title="Choose input type">{uploading ? '…' : '+'}</button>
            {inputMenuOpen && <div className="input-options" id="input-options">
              <button type="button" onClick={() => chooseInput('pdf')}>Upload PDF</button>
              <button type="button" onClick={() => chooseInput('image')}>Upload image</button>
              <button type="button" onClick={() => chooseInput('voice')}>{listening ? 'Stop voice input' : 'Voice input'}</button>
            </div>}
          </div>
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={handleComposerKeyDown} placeholder="Message VeriSight..." aria-label="Message VeriSight" aria-keyshortcuts="Enter" rows="1" />
          <button className="send-button" type="submit" disabled={loading || uploading || apiStatus !== 'online' || draft.trim().length < 3}>{loading ? 'Working...' : 'Send'}</button>
        </div>
        <p>{verifyEnabled ? `Verification is on: using ${evidenceMode === 'document' ? 'your PDF' : evidenceMode === 'image' ? 'text extracted from your image' : evidenceMode === 'hybrid' ? `web and your ${document?.kind === 'image' ? 'image text' : 'PDF'}` : 'web evidence'}.${uncertaintyEnabled ? ' Uncertainty uses two additional answer samples.' : ''}` : 'Verification is off: this response will not receive a reliability score.'}</p>
        {error && <strong className="error">{error}</strong>}
      </form>
      <AuthDialog
        open={authOpen}
        recoveryRequested={passwordRecoveryOpen}
        onClose={() => { setAuthOpen(false); setPasswordRecoveryOpen(false) }}
        onAuthenticated={() => setAuthOpen(false)}
        onRecoveryHandled={() => setPasswordRecoveryOpen(false)}
      />
    </section>
  </main>
}

export default App

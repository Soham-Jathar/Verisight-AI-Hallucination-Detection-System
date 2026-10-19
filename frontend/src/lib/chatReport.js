function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function percent(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? Math.round(value * 100)
    : null
}

export function reportExchanges(conversation) {
  const exchanges = []
  let question = null
  for (const message of Array.isArray(conversation?.messages) ? conversation.messages : []) {
    if (message?.role === 'user' && typeof message.content === 'string' && message.content.trim()) {
      question = message.content.trim()
    } else if (message?.role === 'assistant' && question && !message.pending && typeof message.content === 'string' && message.content.trim()) {
      exchanges.push({ question, answer: message.content.trim(), model: message.model, verification: message.verification })
      question = null
    }
  }
  return exchanges
}

function average(values) {
  const measured = values.filter((value) => value !== null)
  return measured.length ? Math.round(measured.reduce((sum, value) => sum + value, 0) / measured.length) : null
}

function metricName(value) {
  return value === null ? 'Not measured' : `${value}%`
}

function metricBar(label, value, kind) {
  return `<div class="metric-row"><span class="metric-name">${label}</span><div class="track" aria-hidden="true">${value === null ? '' : `<div class="fill ${kind}" style="width:${value}%"></div>`}</div><strong>${metricName(value)}</strong></div>`
}

function claimCounts(verification) {
  const counts = { supported: 0, uncertain: 0, unsupported: 0 }
  for (const claim of Array.isArray(verification?.claims) ? verification.claims : []) {
    if (Object.hasOwn(counts, claim?.status)) counts[claim.status] += 1
  }
  return counts
}

function rowsForConversation(conversation) {
  return reportExchanges(conversation).map((exchange) => {
    const reliability = percent(exchange.verification?.reliability_score)
    const uncertainty = percent(exchange.verification?.uncertainty_score)
    const counts = claimCounts(exchange.verification)
    return { ...exchange, chatTitle: conversation?.title || 'Untitled chat', reliability, uncertainty, counts }
  })
}

export function completedChatCount(conversations) {
  return (Array.isArray(conversations) ? conversations : []).filter((conversation) => reportExchanges(conversation).length > 0).length
}

export function buildChatReportHtml(conversation, generatedAt = new Date()) {
  const rows = rowsForConversation(conversation).map((row, index) => ({ ...row, index: index + 1 }))
  if (!rows.length) throw new Error('This chat has no completed question-and-answer pairs to show insights for.')
  return renderInsightsHtml({ title: conversation?.title || 'Untitled chat', rows, generatedAt, accountScope: false })
}

export function buildAccountInsightsHtml(conversations, generatedAt = new Date()) {
  const chats = (Array.isArray(conversations) ? conversations : [])
    .map((conversation) => ({ title: conversation?.title || 'Untitled chat', rows: rowsForConversation(conversation) }))
    .filter((chat) => chat.rows.length > 0)
  if (!chats.length) throw new Error('Your saved chats have no completed question-and-answer pairs to show insights for.')
  const rows = chats.flatMap((chat) => chat.rows).map((row, index) => ({ ...row, index: index + 1 }))
  return renderInsightsHtml({ title: 'All chats', rows, chats, generatedAt, accountScope: true })
}

function renderInsightsHtml({ title, rows, chats = [], generatedAt, accountScope }) {
  const safeTitle = escapeHtml(title)
  const created = escapeHtml(generatedAt.toLocaleString())
  const measuredReliability = rows.filter((row) => row.reliability !== null).length
  const measuredUncertainty = rows.filter((row) => row.uncertainty !== null).length
  const meanReliability = average(rows.map((row) => row.reliability))
  const meanUncertainty = average(rows.map((row) => row.uncertainty))
  const totals = rows.reduce((sum, row) => ({
    supported: sum.supported + row.counts.supported,
    uncertain: sum.uncertain + row.counts.uncertain,
    unsupported: sum.unsupported + row.counts.unsupported,
  }), { supported: 0, uncertain: 0, unsupported: 0 })

  const overview = rows.map((row) => `<div class="overview-row"><b class="overview-index">${String(row.index).padStart(2, '0')}</b><div class="overview-main">${accountScope ? `<span class="overview-chat">${escapeHtml(row.chatTitle)}</span>` : ''}<p class="overview-question" title="${escapeHtml(row.question)}">${escapeHtml(row.question)}</p><div class="overview-metrics">${metricBar('Reliability', row.reliability, 'reliability')}${metricBar('Uncertainty', row.uncertainty, 'uncertainty')}</div></div></div>`).join('')
  const chatBreakdown = accountScope ? `<section class="chat-breakdown"><h2>By chat</h2><div class="chat-list">${chats.map((chat) => {
    const reliability = average(chat.rows.map((row) => row.reliability))
    const uncertainty = average(chat.rows.map((row) => row.uncertainty))
    return `<div class="chat-list-row"><strong>${escapeHtml(chat.title)}</strong><span>${chat.rows.length} answered question${chat.rows.length === 1 ? '' : 's'}</span><span>Reliability ${metricName(reliability)}</span><span>Uncertainty ${metricName(uncertainty)}</span></div>`
  }).join('')}</div><p class="note">Chat averages use only recorded scores. Chats without completed answers are not included.</p></section>` : ''
  const details = rows.map((row) => {
    const compared = Array.isArray(row.verification?.comparisons) && row.verification.comparisons.length > 1
      ? `<div class="comparison"><h3>Model comparison</h3><div class="comparison-list">${row.verification.comparisons.map((item) => `<p><span>${escapeHtml(item.model || item.provider || 'Model')}</span><strong>${metricName(percent(item.reliability_score))} reliability</strong></p>`).join('')}</div></div>`
      : ''
    const verification = row.verification
      ? `<div class="verdicts" aria-label="Claim verdicts"><span class="verdict supported">${row.counts.supported} supported</span><span class="verdict uncertain">${row.counts.uncertain} needs review</span><span class="verdict unsupported">${row.counts.unsupported} unsupported</span></div>${row.verification.message ? `<p class="verification-note">${escapeHtml(row.verification.message)}</p>` : ''}`
      : '<p class="verification-note">Verification was not recorded for this answer.</p>'
    return `<section class="exchange" id="question-${row.index}"><div class="exchange-heading"><div><span class="eyebrow">Exchange ${String(row.index).padStart(2, '0')}</span><h2>Question ${row.index}</h2>${accountScope ? `<span class="exchange-chat">From ${escapeHtml(row.chatTitle)}</span>` : ''}</div><span class="model">${escapeHtml(row.model || 'Model not recorded')}</span></div><div class="qa"><div class="qa-block"><h3>Question</h3><p>${escapeHtml(row.question)}</p></div><div class="qa-block"><h3>Answer</h3><p>${escapeHtml(row.answer)}</p></div></div><div class="turn-chart" role="img" aria-label="Question ${row.index}: reliability ${metricName(row.reliability)}, uncertainty ${metricName(row.uncertainty)}">${metricBar('Reliability', row.reliability, 'reliability')}${metricBar('Uncertainty', row.uncertainty, 'uncertainty')}</div>${verification}${compared}</section>`
  }).join('')

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${accountScope ? 'Account' : 'Conversation'} Insights - ${safeTitle}</title>
<style>
  :root{font-family:Arial,Helvetica,sans-serif;color:#17253b;background:#edf1f6}*{box-sizing:border-box}body{margin:0}.toolbar{position:sticky;top:0;z-index:2;display:flex;justify-content:space-between;align-items:center;gap:16px;padding:12px max(22px,calc((100% - 850px)/2));background:#142039;color:white}.toolbar button{border:0;border-radius:7px;background:#6f7fdf;color:white;padding:10px 15px;font-weight:700;cursor:pointer}.report{max-width:850px;margin:26px auto;padding:38px 46px;background:white;box-shadow:0 10px 40px #12213a18}.eyebrow{color:#5565bb;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}h1{margin:7px 0 5px;font-size:29px;line-height:1.18;overflow-wrap:anywhere}h2{margin:0 0 14px;font-size:18px}h3{margin:0 0 5px;font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:#63728a}.muted,.note{color:#60708a;font-size:12px;line-height:1.5}.summary{margin-top:24px}.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.stat{padding:13px;border:1px solid #dce3ed;border-radius:8px;background:#f7f9fc}.stat b{display:block;font-size:20px}.stat span{font-size:11px;color:#61718a}.overview,.exchange{margin-top:27px;padding-top:20px;border-top:1px solid #dce3ed}.overview-row{display:grid;grid-template-columns:38px 1fr;gap:12px;align-items:center;padding:10px 0;border-top:1px solid #edf0f4}.overview-row>b{font-size:12px;color:#566581}.metric-row{display:grid;grid-template-columns:92px minmax(0,1fr) 96px;align-items:center;gap:10px;margin:6px 0;font-size:11px}.metric-name{color:#47566e}.metric-row strong{text-align:right;font-size:11px}.track{height:11px;border-radius:99px;background:#e7ecf2;overflow:hidden}.fill{height:100%;border-radius:99px}.fill.reliability{background:#277f79}.fill.uncertainty{background:#db8a40}.qa{padding:14px 17px;border-left:3px solid #6678cf;background:#f7f9fc}.qa p{white-space:pre-wrap;overflow-wrap:anywhere;margin:0 0 15px;font-size:12px;line-height:1.55}.qa p:last-child{margin-bottom:0}.model,.verdicts,.verification-note,.comparison p{font-size:11px;line-height:1.5}.model{color:#566581}.turn-chart{margin:13px 0;padding:12px 15px;border:1px solid #dce3ed;border-radius:8px}.verification-note{color:#5b6c83}.comparison{margin-top:12px}.comparison p{margin:4px 0}.footer{margin-top:30px;padding-top:15px;border-top:1px solid #dce3ed}.footer p{font-size:10px;color:#66758c;line-height:1.5}
  @media print{@page{size:A4;margin:18mm 16mm}html,body{background:white}.toolbar{display:none}.report{max-width:none;margin:0;padding:0;box-shadow:none}.overview-row,.turn-chart,.stat,.qa{break-inside:avoid}.exchange h2{break-after:avoid}.exchange{break-inside:auto}.footer{break-inside:avoid}a{color:inherit;text-decoration:none}}
  @media(max-width:600px){.report{margin:0;padding:25px 18px}.stats{grid-template-columns:1fr}.metric-row{grid-template-columns:80px minmax(0,1fr) 87px}.toolbar{padding:12px 18px}}
  /* Small visual polish, while keeping the report readable when printed. */
  :root{font-family:system-ui,-apple-system,"Segoe UI",Arial,sans-serif;color:#1b2a41;background:#f0f3f8}
  .toolbar{padding:11px max(24px,calc((100% - 900px)/2));background:#17243c}
  .toolbar-brand{display:flex;align-items:center;gap:10px;font-size:13px;font-weight:700;letter-spacing:.01em}
  .toolbar-mark{display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:#6c7bd4;color:#fff;font-size:14px}
  .toolbar button{background:#fff;color:#243659;border-radius:8px;padding:9px 14px}
  .toolbar button:hover{background:#e9eeff}
  .report{max-width:900px;margin:28px auto;padding:40px 46px;border:1px solid #e0e6ef;border-radius:15px;box-shadow:0 12px 34px #1d315112}
  .report-header{padding-bottom:22px;border-bottom:1px solid #e5eaf1}
  .report-headline{display:flex;justify-content:space-between;align-items:center;gap:12px}
  .snapshot{padding:5px 9px;border:1px solid #dae1ec;border-radius:99px;background:#f6f8fc;color:#61718a;font-size:10px;font-weight:700;white-space:nowrap}
  .eyebrow{color:#5d6dc3;font-size:10px;letter-spacing:.11em}
  h1{margin:10px 0 7px;font-size:30px;letter-spacing:-.025em}
  h2{margin-bottom:12px;font-size:18px;letter-spacing:-.01em}
  .muted,.note{font-size:12px;line-height:1.6}
  .report-header .muted{margin:0}
  .summary{margin-top:27px}
  .stats{gap:12px}
  .stat{min-height:94px;padding:15px 16px;border-color:#e0e6ef;border-radius:10px;background:#f8fafd}
  .stat:nth-child(1){border-top:3px solid #7380d9}
  .stat:nth-child(2){border-top:3px solid #2a8c81}
  .stat:nth-child(3){border-top:3px solid #d88c48}
  .stat b{font-size:25px;line-height:1.2}
  .stat span{display:block;margin-top:7px;font-size:11px;line-height:1.4}
  .summary .note{margin:13px 0 0}
  .stats.account{grid-template-columns:repeat(4,minmax(0,1fr))}
  .stats.account .stat:nth-child(2){border-top-color:#7380d9}
  .stats.account .stat:nth-child(3){border-top-color:#2a8c81}
  .stats.account .stat:nth-child(4){border-top:3px solid #d88c48}
  .overview,.details,.chat-breakdown{margin-top:30px;padding-top:24px;border-top:1px solid #e5eaf1}
  .chat-list{display:grid;gap:8px}
  .chat-list-row{display:grid;grid-template-columns:minmax(0,1.6fr) repeat(3,minmax(0,1fr));align-items:center;gap:12px;padding:11px 13px;border:1px solid #e5eaf1;border-radius:8px;background:#f8fafd;color:#5e6e84;font-size:11px}
  .chat-list-row strong{color:#263750;overflow-wrap:anywhere}
  .chat-breakdown .note{margin:10px 0 0}
  .overview-row{grid-template-columns:30px minmax(0,1fr);gap:14px;padding:13px 0;border-color:#edf0f5}
  .overview-index{display:grid;place-items:center;width:28px;height:28px;border-radius:7px;background:#eef1fb;color:#5665ad;font-size:11px}
  .overview-main{min-width:0}
  .overview-chat,.exchange-chat{display:block;color:#5c6ca2;font-size:10px;font-weight:700;overflow-wrap:anywhere}
  .overview-chat{margin-bottom:4px}
  .overview-question{overflow:hidden;margin:0 0 7px;color:#243650;font-size:12px;font-weight:650;text-overflow:ellipsis;white-space:nowrap}
  .metric-row{grid-template-columns:92px minmax(0,1fr) 90px;gap:10px;margin:7px 0;font-size:11px}
  .metric-row strong{font-size:11px}
  .track{height:9px;background:#e9edf3}
  .fill.reliability{background:#298d81}
  .fill.uncertainty{background:#da8d48}
  .exchange{margin-top:15px;padding:20px;border:1px solid #e0e6ef;border-radius:11px;background:#fff}
  .exchange-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:15px;margin-bottom:14px}
  .exchange-heading h2{margin:4px 0 0}
  .model{max-width:45%;margin:0;padding:6px 9px;border:1px solid #e0e6ef;border-radius:6px;background:#f7f9fc;color:#53637a;font-size:10px;overflow-wrap:anywhere}
  .qa{padding:0;border:1px solid #e8edf3;border-left:3px solid #7482d7;border-radius:7px;background:#f8fafd}
  .qa-block{padding:13px 15px}
  .qa-block+.qa-block{border-top:1px solid #e7ecf3}
  .qa h3{margin-bottom:6px}
  .qa p{margin:0;font-size:12px;line-height:1.6}
  .turn-chart{margin:14px 0 11px;padding:11px 14px;border-color:#e0e6ef;background:#fff}
  .verdicts{display:flex;flex-wrap:wrap;gap:6px;margin:11px 0}
  .verdict{padding:5px 8px;border-radius:6px;background:#f1f4f8;color:#61718a;font-size:10px;font-weight:700}
  .verdict.supported{background:#eaf5f0;color:#247d68}
  .verdict.uncertain{background:#fff3e6;color:#9b6528}
  .verdict.unsupported{background:#fceced;color:#ac4f5b}
  .verification-note{margin:10px 0 0;line-height:1.55}
  .comparison{margin-top:14px;padding-top:12px;border-top:1px solid #e8edf3}
  .comparison-list{display:grid;gap:4px}
  .comparison p{display:flex;justify-content:space-between;gap:12px;margin:0;padding:6px 0;color:#52627a}
  .comparison strong{color:#243650;white-space:nowrap}
  .footer{margin-top:31px}
  @media print{.report{border:0;border-radius:0;box-shadow:none}.exchange{break-inside:auto}.exchange-heading,.qa-block,.turn-chart,.verdicts,.chat-list-row{break-inside:avoid}}
  @media(max-width:600px){.report{margin:0;padding:24px 18px;border:0;border-radius:0}.stats,.stats.account{grid-template-columns:1fr}.chat-list-row{grid-template-columns:repeat(2,minmax(0,1fr))}.chat-list-row strong{grid-column:1/-1}.report-headline{align-items:flex-start}.exchange{padding:15px}.exchange-heading{flex-direction:column;gap:8px}.model{max-width:100%}.metric-row{grid-template-columns:79px minmax(0,1fr) 86px}.toolbar{gap:8px;flex-wrap:wrap;padding:11px 16px}.toolbar-brand{font-size:12px}.toolbar button{padding:8px 10px;font-size:11px}}
</style></head><body><div class="toolbar"><span class="toolbar-brand"><span class="toolbar-mark" aria-hidden="true">V</span>${accountScope ? 'Account Insights' : 'Conversation Insights'}</span><button type="button" onclick="window.print()">Print / Save as PDF</button></div><main class="report"><header class="report-header"><div class="report-headline"><div class="eyebrow">VERISIGHT · ${accountScope ? 'ACCOUNT INSIGHTS' : 'CONVERSATION INSIGHTS'}</div><span class="snapshot">${accountScope ? 'Account snapshot' : 'Chat snapshot'}</span></div><h1>${safeTitle}</h1><p class="muted">Generated ${created} from ${accountScope ? 'chats currently loaded for this signed-in account' : 'this signed-in chat'}. Only completed question-and-answer pairs are included.</p></header>
<section class="summary"><h2>${accountScope ? 'Account summary' : 'Conversation summary'}</h2><div class="stats${accountScope ? ' account' : ''}">${accountScope ? `<div class="stat"><b>${chats.length}</b><span>Chats with answers</span></div>` : ''}<div class="stat"><b>${rows.length}</b><span>Answered questions</span></div><div class="stat"><b>${metricName(meanReliability)}</b><span>Average of ${measuredReliability} measured reliability score${measuredReliability === 1 ? '' : 's'}</span></div><div class="stat"><b>${metricName(meanUncertainty)}</b><span>Average of ${measuredUncertainty} measured uncertainty score${measuredUncertainty === 1 ? '' : 's'}</span></div></div><p class="note">Claim verdicts ${accountScope ? 'across these chats' : 'in this chat'}: ${totals.supported} supported, ${totals.uncertain} needs review, ${totals.unsupported} unsupported. Averages use only available scores; they are not a new verification score for ${accountScope ? 'the account' : 'the whole chat'}.</p></section>
${chatBreakdown}<section class="overview"><h2>Scores by question</h2><p class="note">Green shows reliability; orange shows estimated uncertainty. They describe different things and do not need to add to 100%.</p>${overview}</section><section class="details"><h2>Questions and answers</h2>${details}</section><footer class="footer"><p>Reliability summarizes the recorded claim checks against available evidence. Uncertainty estimates variation across extra model samples when that option was enabled. “Not measured” means no score was recorded; it is not 0%. These insights are a snapshot of ${accountScope ? 'the signed-in account’s loaded chats at the time this page was opened' : 'the selected chat'}, not a fresh verification run.</p></footer></main></body></html>`
}

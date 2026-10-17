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

export function buildChatReportHtml(conversation, generatedAt = new Date()) {
  const exchanges = reportExchanges(conversation)
  if (!exchanges.length) throw new Error('This chat has no completed question-and-answer pairs to show insights for.')

  const title = escapeHtml(conversation?.title || 'Untitled chat')
  const created = escapeHtml(generatedAt.toLocaleString())
  const rows = exchanges.map((exchange, index) => {
    const reliability = percent(exchange.verification?.reliability_score)
    const uncertainty = percent(exchange.verification?.uncertainty_score)
    const counts = claimCounts(exchange.verification)
    return { ...exchange, index: index + 1, reliability, uncertainty, counts }
  })
  const measuredReliability = rows.filter((row) => row.reliability !== null).length
  const measuredUncertainty = rows.filter((row) => row.uncertainty !== null).length
  const meanReliability = average(rows.map((row) => row.reliability))
  const meanUncertainty = average(rows.map((row) => row.uncertainty))
  const totals = rows.reduce((sum, row) => ({
    supported: sum.supported + row.counts.supported,
    uncertain: sum.uncertain + row.counts.uncertain,
    unsupported: sum.unsupported + row.counts.unsupported,
  }), { supported: 0, uncertain: 0, unsupported: 0 })

  const overview = rows.map((row) => `<div class="overview-row"><b>Q${row.index}</b><div class="overview-metrics">${metricBar('Reliability', row.reliability, 'reliability')}${metricBar('Uncertainty', row.uncertainty, 'uncertainty')}</div></div>`).join('')
  const details = rows.map((row) => {
    const compared = Array.isArray(row.verification?.comparisons) && row.verification.comparisons.length > 1
      ? `<div class="comparison"><h3>Model comparison</h3>${row.verification.comparisons.map((item) => `<p>${escapeHtml(item.model || item.provider || 'Model')}: <strong>${metricName(percent(item.reliability_score))} reliability</strong></p>`).join('')}</div>`
      : ''
    const verification = row.verification
      ? `<p class="verdicts">Claims: ${row.counts.supported} supported · ${row.counts.uncertain} needs review · ${row.counts.unsupported} unsupported</p>${row.verification.message ? `<p class="verification-note">${escapeHtml(row.verification.message)}</p>` : ''}`
      : '<p class="verification-note">Verification was not recorded for this answer.</p>'
    return `<section class="exchange"><h2>Question ${row.index}</h2><div class="qa"><h3>Question</h3><p>${escapeHtml(row.question)}</p><h3>Answer</h3><p>${escapeHtml(row.answer)}</p></div><p class="model">Model: ${escapeHtml(row.model || 'Not recorded')}</p><div class="turn-chart" role="img" aria-label="Question ${row.index}: reliability ${metricName(row.reliability)}, uncertainty ${metricName(row.uncertainty)}">${metricBar('Reliability', row.reliability, 'reliability')}${metricBar('Uncertainty', row.uncertainty, 'uncertainty')}</div>${verification}${compared}</section>`
  }).join('')

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conversation Insights - ${title}</title>
<style>
  :root{font-family:Arial,Helvetica,sans-serif;color:#17253b;background:#edf1f6}*{box-sizing:border-box}body{margin:0}.toolbar{position:sticky;top:0;z-index:2;display:flex;justify-content:space-between;align-items:center;gap:16px;padding:12px max(22px,calc((100% - 850px)/2));background:#142039;color:white}.toolbar button{border:0;border-radius:7px;background:#6f7fdf;color:white;padding:10px 15px;font-weight:700;cursor:pointer}.report{max-width:850px;margin:26px auto;padding:38px 46px;background:white;box-shadow:0 10px 40px #12213a18}.eyebrow{color:#5565bb;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}h1{margin:7px 0 5px;font-size:29px;line-height:1.18;overflow-wrap:anywhere}h2{margin:0 0 14px;font-size:18px}h3{margin:0 0 5px;font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:#63728a}.muted,.note{color:#60708a;font-size:12px;line-height:1.5}.summary{margin-top:24px}.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.stat{padding:13px;border:1px solid #dce3ed;border-radius:8px;background:#f7f9fc}.stat b{display:block;font-size:20px}.stat span{font-size:11px;color:#61718a}.overview,.exchange{margin-top:27px;padding-top:20px;border-top:1px solid #dce3ed}.overview-row{display:grid;grid-template-columns:38px 1fr;gap:12px;align-items:center;padding:10px 0;border-top:1px solid #edf0f4}.overview-row>b{font-size:12px;color:#566581}.metric-row{display:grid;grid-template-columns:92px minmax(0,1fr) 96px;align-items:center;gap:10px;margin:6px 0;font-size:11px}.metric-name{color:#47566e}.metric-row strong{text-align:right;font-size:11px}.track{height:11px;border-radius:99px;background:#e7ecf2;overflow:hidden}.fill{height:100%;border-radius:99px}.fill.reliability{background:#277f79}.fill.uncertainty{background:#db8a40}.qa{padding:14px 17px;border-left:3px solid #6678cf;background:#f7f9fc}.qa p{white-space:pre-wrap;overflow-wrap:anywhere;margin:0 0 15px;font-size:12px;line-height:1.55}.qa p:last-child{margin-bottom:0}.model,.verdicts,.verification-note,.comparison p{font-size:11px;line-height:1.5}.model{color:#566581}.turn-chart{margin:13px 0;padding:12px 15px;border:1px solid #dce3ed;border-radius:8px}.verification-note{color:#5b6c83}.comparison{margin-top:12px}.comparison p{margin:4px 0}.footer{margin-top:30px;padding-top:15px;border-top:1px solid #dce3ed}.footer p{font-size:10px;color:#66758c;line-height:1.5}
  @media print{@page{size:A4;margin:18mm 16mm}html,body{background:white}.toolbar{display:none}.report{max-width:none;margin:0;padding:0;box-shadow:none}.overview-row,.turn-chart,.stat,.qa{break-inside:avoid}.exchange h2{break-after:avoid}.exchange{break-inside:auto}.footer{break-inside:avoid}a{color:inherit;text-decoration:none}}
  @media(max-width:600px){.report{margin:0;padding:25px 18px}.stats{grid-template-columns:1fr}.metric-row{grid-template-columns:80px minmax(0,1fr) 87px}.toolbar{padding:12px 18px}}
</style></head><body><div class="toolbar"><span>Conversation Insights</span><button type="button" onclick="window.print()">Print / Save as PDF</button></div><main class="report"><header><div class="eyebrow">VeriSight · Conversation Insights</div><h1>${title}</h1><p class="muted">Generated ${created} from this signed-in chat. Only completed question-and-answer pairs are included.</p></header>
<section class="summary"><h2>Conversation summary</h2><div class="stats"><div class="stat"><b>${rows.length}</b><span>Answered questions</span></div><div class="stat"><b>${metricName(meanReliability)}</b><span>Average of ${measuredReliability} measured reliability score${measuredReliability === 1 ? '' : 's'}</span></div><div class="stat"><b>${metricName(meanUncertainty)}</b><span>Average of ${measuredUncertainty} measured uncertainty score${measuredUncertainty === 1 ? '' : 's'}</span></div></div><p class="note">Claim verdicts in this chat: ${totals.supported} supported, ${totals.uncertain} needs review, ${totals.unsupported} unsupported. Averages use only available scores; they are not a new verification score for the whole chat.</p></section>
<section class="overview"><h2>Scores by question</h2><p class="note">Green shows reliability; orange shows estimated uncertainty. They describe different things and do not need to add to 100%.</p>${overview}</section><section class="details"><h2>Questions and answers</h2>${details}</section><footer class="footer"><p>Reliability summarizes the recorded claim checks against available evidence. Uncertainty estimates variation across extra model samples when that option was enabled. “Not measured” means no score was recorded; it is not 0%. These insights are a snapshot of the selected chat, not a fresh verification run.</p></footer></main></body></html>`
}

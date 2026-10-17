import test from 'node:test'
import assert from 'node:assert/strict'

import { buildChatReportHtml, reportExchanges } from './chatReport.js'

const timestamp = new Date('2026-10-17T12:00:00Z')

function conversation(messages) {
  return { title: 'A test chat', messages }
}

test('pairs each completed answer with its question and skips pending turns', () => {
  const exchanges = reportExchanges(conversation([
    { role: 'user', content: 'First question?' },
    { role: 'assistant', content: 'First answer.' },
    { role: 'user', content: 'Second question?' },
    { role: 'assistant', pending: true },
  ]))
  assert.equal(exchanges.length, 1)
  assert.equal(exchanges[0].question, 'First question?')
  assert.equal(exchanges[0].answer, 'First answer.')
})

test('plots measured values and labels unavailable uncertainty without inventing zero', () => {
  const html = buildChatReportHtml(conversation([
    { role: 'user', content: 'Question one?' },
    { role: 'assistant', content: 'Answer one.', model: 'Gemini', verification: { reliability_score: 0.92, uncertainty_score: 0, claims: [{ status: 'supported' }] } },
    { role: 'user', content: 'Question two?' },
    { role: 'assistant', content: 'Answer two.', verification: { reliability_score: null, uncertainty_score: null, claims: [{ status: 'uncertain' }] } },
  ]), timestamp)
  assert.match(html, /Question 1/)
  assert.match(html, /Question 2/)
  assert.match(html, /Conversation Insights/)
  assert.match(html, /92%/)
  assert.match(html, /0%/)
  assert.match(html, /Not measured/)
  assert.match(html, /width:92%/)
  assert.match(html, /1 supported, 1 needs review, 0 unsupported/)
  assert.match(html, /Print \/ Save as PDF/)
})

test('escapes stored question and answer text before inserting it into report HTML', () => {
  const html = buildChatReportHtml({ title: '<script>alert(1)</script>', messages: [
    { role: 'user', content: '<img src=x onerror=alert(1)>' },
    { role: 'assistant', content: 'Answer & "quote"', verification: null },
  ] }, timestamp)
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/)
  assert.doesNotMatch(html, /<img src=x/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.match(html, /Answer &amp; &quot;quote&quot;/)
})

test('does not generate a report from an empty or pending-only chat', () => {
  assert.throws(() => buildChatReportHtml(conversation([]), timestamp), /no completed/)
  assert.throws(() => buildChatReportHtml(conversation([
    { role: 'user', content: 'Question?' },
    { role: 'assistant', pending: true },
  ]), timestamp), /no completed/)
})

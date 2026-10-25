import test from 'node:test';
import assert from 'node:assert/strict';
import {renderMatchCard} from '../match-card.mjs';

const match = {
  id: 42,
  gameweek: 7,
  kickoff: '2026-10-24T14:00:00Z',
  fixtureStatus: 'awaiting_result',
  home: {name:'Arsenal',short:'ARS',code:1,recent:[]},
  away: {name:'Chelsea',short:'CHE',code:2,recent:[]},
  predictions: {
    jev: {outcome:'home',score:[2,1],probabilities:{home:.6,draw:.25,away:.15},model:'jev-v1',generatedAt:'2026-10-23T09:00:00Z'},
    openai: {outcome:'draw',score:[1,1],probabilities:{home:.3,draw:.4,away:.3},model:'gpt-6-luna',generatedAt:'2026-10-23T09:01:00Z',stale:true},
  },
  forecastStates: {
    jev:{availability:'fresh',status:'complete'},
    openai:{availability:'retained',status:'failed',attemptCount:2,nextAttemptAt:'2026-10-24T08:00:00Z'},
    claude:{availability:'missing',status:'exhausted',attemptCount:3},
    gemini:{availability:'missing',status:'started',attemptCount:1},
  },
};

test('a match card lists each agent once and puts probabilities on the accessible forecast disclosure',()=>{
  const html=renderMatchCard(match);
  const names=['Jev','Decisions','Claude','ChatGPT','Gemini'];
  let prior=-1;
  for(const name of names){
    const index=html.indexOf(`>${name}<`);
    assert.ok(index>prior,`${name} appears in registry order`);
    prior=index;
  }
  assert.equal((html.match(/class="agent-row"/g)||[]).length,5);
  assert.equal((html.match(/class="agent-probability-row/g)||[]).length,5);
  assert.match(html,/aria-label="Jev prediction probabilities: ARS 60%, Draw 25%, CHE 15%"/);
  assert.match(html,/data-weight="0\.6"/);
  assert.match(html,/class="agent-result">Arsenal win<\/span><strong>2 : 1<\/strong>/);
  assert.doesNotMatch(html,/<summary>Details<\/summary>/);
  assert.match(html,/aria-label="Jev: Arsenal win, predicted score 2 : 1"/);
  assert.match(html,/gpt-6-luna/);
  assert.match(html,/2026-10-23T09:01:00Z/);
  assert.match(html,/Retries exhausted/);
  assert.match(html,/Attempt 2 of 3/);
  assert.match(html,/No prediction/);
  assert.match(html,/Refresh in progress/);
  assert.match(html,/Attempt 1 of 3/);
  assert.match(html,/Awaiting result/);
  assert.doesNotMatch(html,/Decisions API/);
  assert.match(html,/aria-label="Decisions forecast"/);
  assert.match(html,/aria-label="Decisions: Draw, predicted score 1 : 1"/);
});

test('missing agents stay visible without an invented forecast',()=>{
  const html=renderMatchCard({...match,predictions:{},forecastStates:{}});
  assert.equal((html.match(/class="agent-row"/g)||[]).length,5);
  assert.equal((html.match(/class="forecast-state missing">No prediction<\/span>/g)||[]).length,5);
  assert.doesNotMatch(html,/predicted score/i);
});

test('fixture rescheduling remains visible in the match header',()=>{
  assert.match(renderMatchCard({...match,fixtureStatus:'awaiting_rescheduling'}),/Awaiting rescheduling/);
});

import {AGENT_IDS} from '../agents.mjs';
import {predictMatch} from './jev.mjs';
import {predictDecision} from './decisions.mjs';
import {predictClaude} from './claude.mjs';
import {predictChatGPT} from './chatgpt.mjs';
import {predictGemini} from './gemini.mjs';

export const PREDICTORS=Object.freeze({jev:predictMatch,openai:predictDecision,claude:predictClaude,chatgpt:predictChatGPT,gemini:predictGemini});
const credentials={jev:'AI_GATEWAY_API_KEY',openai:'OPENAI_API_KEY',claude:'ANTHROPIC_API_KEY',chatgpt:'OPENAI_API_KEY',gemini:'GEMINI_API_KEY'};
export function providersConfigured(env=process.env) {
  return Object.fromEntries(AGENT_IDS.map(id=>[id,!!env[credentials[id]]]));
}

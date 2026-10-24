// Public agent identities. Keep credentials and provider clients in server modules.
export const AGENTS = Object.freeze([
  {id:'jev',name:'Jev',model:'typesafe-ai/jev'},
  {id:'openai',name:'Decisions API',model:'gpt-6-luna'},
  {id:'claude',name:'Claude',model:'claude-haiku-5-5'},
  {id:'chatgpt',name:'ChatGPT',model:'gpt-6.1-sol'},
  {id:'gemini',name:'Gemini',model:'gemini-3.1-flash-lite'},
].map(Object.freeze));
export const AGENT_IDS = Object.freeze(AGENTS.map(agent=>agent.id));

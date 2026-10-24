import {jsonFetch} from './http.mjs';
import {forecastPrompt,forecastSchema,parseStructuredForecast} from './structured-forecast.mjs';
import {providerMetadata,rejectedResponse} from './provider-usage.mjs';

export async function predictChatGPT(match,{apiKey=process.env.OPENAI_API_KEY}={}) {
  if(!apiKey) throw new Error('OPENAI_API_KEY is not configured.');
  const body=await jsonFetch('https://api.openai.com/v1/responses',{
    method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},
    body:JSON.stringify({model:'gpt-6.1-sol',input:forecastPrompt(match),store:false,
      max_output_tokens:4096,reasoning:{effort:'low'},
      text:{format:{type:'json_schema',name:'score_forecast',strict:true,schema:forecastSchema()}}}),
  },{attempts:1});
  const metadata=providerMetadata('chatgpt',body);
  const messages=Array.isArray(body?.output) ? body.output.filter(item=>item?.type==='message') : [];
  const content=messages?.flatMap(item=>item.content??[]);
  if(body?.status!=='completed' || messages?.length!==1 || content?.length!==1 || content[0]?.type!=='output_text') throw rejectedResponse(metadata);
  return parseStructuredForecast(content[0].text,metadata);
}

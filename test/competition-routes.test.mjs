import {test} from 'node:test';
import assert from 'node:assert/strict';
import activateHandler from '../api/competition/activate.mjs';
import manualHandler from '../api/cron/predictions/manual.mjs';

const call=async(handler,request)=>{
  let body;
  const response={setHeader(){},end(value){body=JSON.parse(value);}};
  await handler(request,response);
  return {status:response.statusCode,body};
};

test('competition activation and paid manual run routes require a configured shared secret',async()=>{
  const previous=process.env.CRON_SECRET;
  try{
    delete process.env.CRON_SECRET;
    assert.equal((await call(activateHandler,{method:'POST',headers:{}})).status,503);
    assert.equal((await call(manualHandler,{method:'POST',headers:{}})).status,503);
  }finally{
    if(previous===undefined)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=previous;
  }
});

test('competition activation and paid manual run reject unauthorized and non-POST requests',async()=>{
  const previous=process.env.CRON_SECRET;
  try{
    process.env.CRON_SECRET='test-only-secret';
    for(const handler of [activateHandler,manualHandler]){
      assert.equal((await call(handler,{method:'GET',headers:{authorization:'Bearer test-only-secret'}})).status,405);
      assert.equal((await call(handler,{method:'POST',headers:{authorization:'Bearer wrong'}})).status,401);
    }
  }finally{
    if(previous===undefined)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=previous;
  }
});

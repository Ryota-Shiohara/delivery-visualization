import {InputError} from './local-contract.mjs';
export function pageLimit(params,maximum=1000,fallback=500){
 const raw=params.get('limit');
 if(raw!==null&&!/^\d+$/.test(raw))throw new InputError('limitは正の整数にしてください。');
 const limit=raw===null?Math.min(fallback,maximum):Number(raw);
 if(!Number.isInteger(limit)||limit<1||limit>1000)throw new InputError('limitは1〜1000にしてください。');
 return Math.min(limit,maximum);
}
export function encodeCursor(scope,key){return key&&Object.keys(key).length?Buffer.from(JSON.stringify({version:1,scope,key})).toString('base64url'):null;}
export function decodeCursor(token,scope){
 if(!token)return undefined;
 try{
  if(token.length>8192||!/^[A-Za-z0-9_-]+$/.test(token))throw new Error();
  const value=JSON.parse(Buffer.from(token,'base64url').toString('utf8'));
  if(value.version!==1||value.scope!==scope||!value.key||Array.isArray(value.key)||typeof value.key!=='object')throw new Error();
  return value.key;
 }catch{throw new InputError('ページの続き情報が不正です。更新して最初から読み込んでください。');}
}

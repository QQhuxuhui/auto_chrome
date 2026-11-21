const { setTimeout: sleep } = require('node:timers/promises');
const { geminiAccountState } = require('./gemini-session');

function inspectInitialization() {
    const visible = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
    const dialogs = [...document.querySelectorAll('[role="dialog"],mat-dialog-container')].filter(visible);
    const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(e => visible(e) && !e.disabled && e.getAttribute('aria-disabled') !== 'true');
    const editor = [...document.querySelectorAll('[role="textbox"][contenteditable="true"],textarea')].some(e => visible(e) && !e.disabled);
    for (const button of buttons) {
        if (button.closest('model-response,user-query,message-content,.conversation-container')) continue;
        const label = (button.innerText || '').trim();
        const dialog = button.closest('[role="dialog"],mat-dialog-container');
        const banner = button.closest('section.gem-banner-container');
        const knownIntro = dialog && /onboarding|Gemini|welcome|开始|欢迎|歡迎/i.test((dialog.getAttribute('aria-label') || '')+' '+dialog.innerText);
        const contentApps = /^(Use without content apps|不使用内容应用)$/.test(label);
        const start = /^(Get started|Use Gemini|开始使用|開始使用)$/.test(label) && (knownIntro || !editor);
        const accept = /^(I agree|Continue|Next|同意|继续|繼續|下一步)$/.test(label) && knownIntro;
        const acknowledge = /^(Got it|知道了|我知道了|明白了)$/.test(label) && (knownIntro || banner && /Gemini/.test(banner.innerText));
        const skip = /^(Skip|Not now|跳过|略過|以后再说)$/.test(label) && knownIntro;
        if (contentApps || start || accept || acknowledge || skip) {
            const prior = document.querySelector('[data-codex-initialization-action]');
            if (prior) prior.removeAttribute('data-codex-initialization-action');
            button.setAttribute('data-codex-initialization-action', 'true');
            return { action: label, editor, dialogs: dialogs.length };
        }
    }
    return { action: null, editor, dialogs: dialogs.length };
}

async function ensureGeminiInitialized(page,email,{timeoutMs=120000,settleMs=2000,log=()=>{}}={}) {
    const started=Date.now(),actions=[];
    let stableAt=0;
    while(Date.now()-started<timeoutMs) {
        if(new URL(page.url()).origin!=='https://gemini.google.com') throw new Error('Gemini初始化页面未登录');
        const identity=await page.evaluate(geminiAccountState,email);
        if(identity==='other-account') throw new Error('Gemini初始化邮箱不匹配');
        const state=await page.evaluate(inspectInitialization);
        if(state.action) {
            stableAt=0;
            if(actions.length>=12) throw new Error('Gemini初始化确认次数超限');
            await page.click('[data-codex-initialization-action="true"]');
            actions.push(state.action);log('完成Gemini首次确认：'+state.action);
            await sleep(1000);continue;
        }
        if(identity==='signed-in' && state.editor && !state.dialogs) {
            if(!stableAt) stableAt=Date.now();
            if(Date.now()-stableAt>=settleMs) return {verified:true,actions,identityConfirmed:true,editorReady:true,remainingDialogs:0,checkedAt:new Date().toISOString()};
        } else stableAt=0;
        await sleep(250);
    }
    throw new Error('Gemini首次初始化未完成或对话输入框不可用');
}
module.exports={inspectInitialization,ensureGeminiInitialized};

'use strict';

// Stripe Address Element can be a separate iframe with translated labels.
// Match autocomplete attributes rather than text or the position of inputs.
async function findCheckoutBillingFrame(page) {
    for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        const field = frame.locator('input[autocomplete~="address-line1"], input[name="addressLine1"]').first();
        if (await field.isVisible().catch(() => false)) return frame;
    }
    return null;
}

async function fillCheckoutBillingFrame(page, address, fullName) {
    const frame = await findCheckoutBillingFrame(page);
    if (!frame) return null;
    const choose = async (selector, value) => {
        const field = frame.locator(selector).filter({visible:true}).first();
        if (!(await field.count())) return;
        const option = await field.locator('option').evaluateAll((options, expected) => {
            const option = options.find(o => o.value.toLowerCase() === expected.toLowerCase() || o.label.toLowerCase() === expected.toLowerCase());
            return option?.value ?? null;
        }, String(value));
        if (option === null) throw new Error('账单地址下拉选项与配置不一致');
        await field.selectOption(option);
    };
    const fill = async (token, value, preserve = false) => {
        const names={'name':'name','address-line1':'addressLine1','address-level2':'locality','postal-code':'postalCode'};
        const selector=`input[autocomplete~="${token}"]${names[token] ? `, input[name="${names[token]}"]` : ''}`;
        const field=frame.locator(selector).filter({visible:true}).first();
        if (!(await field.count())) {
            if (token === 'name') return '';
            throw new Error(`账单字段未找到: ${token}`);
        }
        if (token === 'name' && !(await field.inputValue()).trim() && !String(value || '').trim()) {
            if (await field.evaluate(node => node.required || node.getAttribute('aria-required') === 'true')) {
                throw new Error('官网要求真实持卡人姓名，当前为空');
            }
            return '';
        }
        if (!preserve || !(await field.inputValue()).trim()) await field.fill(String(value || ''));
        if (!(await field.inputValue()).trim()) throw new Error(`账单字段未完整填写: ${token}`);
        return field.inputValue();
    };
    await choose('select[autocomplete~="country"]', address.country || 'US');
    await page.waitForTimeout(500);
    const holderName=await fill('name',fullName,true);
    await fill('address-line1',address.line1);
    await fill('address-level2',address.city);
    await fill('postal-code',address.postal_code);
    const stateSelect=frame.locator('select[autocomplete~="address-level1"]').filter({visible:true});
    if(await stateSelect.count()) await choose('select[autocomplete~="address-level1"]',address.state);
    else if(await frame.locator('input[autocomplete~="address-level1"]:visible').count()) await fill('address-level1',address.state);
    await frame.locator('input[autocomplete~="postal-code"]').first().press('Tab');
    await page.waitForTimeout(1500);
    const invalid=await frame.locator('input:visible,select:visible').evaluateAll(nodes=>nodes.some(n=>!n.checkValidity() || n.getAttribute('aria-invalid')==='true'));
    if(invalid)throw new Error('账单表单仍有无效字段，请人工审查');
    console.log('[Stripe] ✅ 独立账单 iframe 的姓名、国家、街道、城市、州及邮编已填写');
    return {ok:true,holderName};
}

async function verifyCheckoutZeroTax(page, {timeout=25000}={}) {
    const deadline=Date.now()+timeout;
    while(Date.now()<deadline){
        const body=await page.locator('body').innerText();
        const tax=body.match(/(?:Tax\s*\(0%\)|Estimated tax|VAT\s*\(0%\)|税费\s*\(0%\))\s*[₱$€£]\s*([\d,.]+)/i);
        if(tax && Number(tax[1].replace(/,/g,''))===0){
            console.log('[Checkout] 官网页面确认税额为 0');
            return true;
        }
        await page.waitForTimeout(500);
    }
    throw new Error('官网税额重算未确认免税，停止付款；保留当前页面供审查');
}

module.exports = { findCheckoutBillingFrame, fillCheckoutBillingFrame, verifyCheckoutZeroTax };

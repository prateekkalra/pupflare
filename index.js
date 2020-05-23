const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker');
puppeteer.use(AdblockerPlugin());
puppeteer.use(StealthPlugin());
const Koa = require('koa');
const bodyParser = require('koa-bodyparser');
const app = new Koa();
app.use(bodyParser());
const jsesc = require('jsesc');

const headersToRemove = [
    "host", "user-agent", "accept", "accept-encoding", "content-length",
    "forwarded", "x-forwarded-proto", "x-forwarded-for", "x-cloud-trace-context"
];
const responseHeadersToRemove = ["Accept-Ranges", "Content-Length", "Keep-Alive", "Connection", "content-encoding", "set-cookie"];

(async () => {
    let options = {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    };
    if (process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD)
        options.executablePath = '/usr/bin/chromium-browser';
    const browser = await puppeteer.launch(options);
    app.use(async ctx => {
        if (ctx.query.url) {
            const url = ctx.url.replace("/?url=", "");
            let responseBody;
            let responseHeaders;
            const page = await browser.newPage();
            if (ctx.method == "POST") {
                await page.removeAllListeners('request');
                await page.setRequestInterception(true);
                page.on('request', interceptedRequest => {
                    var data = {
                        'method': 'POST',
                        'postData': ctx.request.rawBody
                    };
                    interceptedRequest.continue(data);
                });
            }
            const client = await page.target().createCDPSession();
            await client.send('Network.setRequestInterception', {
                patterns: [{
                    urlPattern: '*',
                    resourceType: 'Document',
                    interceptionStage: 'HeadersReceived'
                }],
            });

            await client.on('Network.requestIntercepted', async e => {
                let obj = { interceptionId: e.interceptionId };
                if (e.isDownload) {
                    await client.send('Network.getResponseBodyForInterception', {
                        interceptionId: e.interceptionId
                    }).then((result) => {
                        if (result.base64Encoded) {
                            responseBody = Buffer.from(result.body, 'base64');
                        }
                    });
                    obj['errorReason'] = 'BlockedByClient';
                    responseHeaders = e.responseHeaders;
                }
                await client.send('Network.continueInterceptedRequest', obj);
                if (e.isDownload)
                    await page.close();
            });
            let headers = ctx.headers;
            headersToRemove.forEach(header => {
                delete headers[header];
            });
            await page.setExtraHTTPHeaders(headers);
            try {
                let response;
                response = await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' });
                if ((await page.content()).includes("cf-browser-verification"))
                    response = await page.waitForNavigation({ timeout: 30000, waitUntil: 'domcontentloaded' });
                responseBody = await page.content();
                responseHeaders = response.headers();
                const cookies = await page.cookies();
                if (cookies)
                    cookies.forEach(cookie => {
                        const { name, value, secure, expires, domain, ...options } = cookie;
                        ctx.cookies.set(cookie.name, cookie.value, options);
                    });
                await page.close();
            } catch (error) {
                if (!error.toString().includes("ERR_BLOCKED_BY_CLIENT")) {
                    ctx.status = 500;
                    ctx.body = error;
                }
            }
            responseHeadersToRemove.forEach(header => delete responseHeaders[header]);
            Object.keys(responseHeaders).forEach(header => ctx.set(header, jsesc(responseHeaders[header])));
            ctx.body = responseBody;
        }
        else {
            ctx.body = "Please specify the URL in the 'url' query string.";
        }
    });
    app.listen(3000);
})();
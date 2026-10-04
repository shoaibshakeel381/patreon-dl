import { BG, buildURL, GOOG_API_KEY, type WebPoSignalOutput } from 'bgutils-js';
import { type WebPoMinter } from 'bgutils-js/dist/core';
import { JSDOM } from 'jsdom';
import { type Dispatcher, fetch } from 'undici';
import Innertube from 'youtubei.js';
import { Window } from 'happy-dom';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36(KHTML, like Gecko)';

interface PoTokenMinterParams {
  minter: WebPoMinter;
  ttl: number;
  refreshThreshold: number;
  created: number;
}

export interface POTokenMinterWrapper {
  pot: (identifier: string) => Promise<string>;
  dispose: () => void;
}

export interface CreatePoTokenMinterOptions {
  proxyAgent?: Dispatcher;
}

export class PoTokenMinter {
  static createInstance(options: CreatePoTokenMinterOptions) {
    return createMinterWrapper(options);
  }
}

function createMinterWrapper(options: CreatePoTokenMinterOptions): POTokenMinterWrapper {
  let minterPromise: Promise<WebPoMinter>;
  let refreshTimer: NodeJS.Timeout | null = null;
  let disposed = false;

  function refresh() {
    if (disposed) {
      return;
    }
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    minterPromise = createMinter(options).then(({minter, ttl, refreshThreshold}) => {
      const timeout = ttl - refreshThreshold - 100;
      refreshTimer = setTimeout(() => {
        if (!disposed) {
          refresh();
        }
      }, timeout * 1000);
      return minter;
    });
  }

  refresh();

  return {
    async pot(identifier: string) {
      if (disposed) {
        throw Error('POTokenMinter disposed');
      }
      const minter = await minterPromise;
      return await minter.mintAsWebsafeString(identifier);
    },
    dispose() {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
      disposed = true;
    }
  };
}

async function createMinter(options: CreatePoTokenMinterOptions): Promise<PoTokenMinterParams> {
  const userAgent = USER_AGENT;
  const innertube = await Innertube.create();
  const challengeResponse = await innertube.getAttestationChallenge(
    'ENGAGEMENT_TYPE_UNBOUND'
  );

  /**
   * Largely taken from:
   * https://github.com/LuanRT/BgUtils/blob/54c511b2bd4e3e3707f30d2907f33167e1b61b35/examples/node/innertube-challenge-fetcher-example.ts
   */

  // #region BotGuard Initialization
  const dom = new JSDOM(
    '<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>',
    {
      url: 'https://www.youtube.com/',
      referrer: 'https://www.youtube.com/',
      userAgent,
      pretendToBeVisual: true
    }
  );
  // Create a Happy DOM window just to access its canvas mock
  const happyWindow = new Window();
  const happyCanvasProto = Object.getPrototypeOf(
    happyWindow.document.createElement('canvas')
  );
  // Patch JSDOM’s canvas with Happy DOM’s mock
  dom.window.HTMLCanvasElement.prototype.getContext =
    happyCanvasProto.getContext;

  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    origin: dom.window.origin
  });

  if (!Reflect.has(globalThis, 'navigator')) {
    Object.defineProperty(globalThis, 'navigator', {
      value: dom.window.navigator
    });
  }

  if (!challengeResponse.bg_challenge) {
    throw Error('Could not get challenge');
  }

  const interpreterUrl =
    challengeResponse.bg_challenge.interpreter_url
      .private_do_not_access_or_else_trusted_resource_url_wrapped_value;
  const bgScriptResponse = await fetch(`https:${interpreterUrl}`);
  const interpreterJavascript = await bgScriptResponse.text();

  if (interpreterJavascript) {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(interpreterJavascript)();
  } else throw new Error('Could not load VM');

  const botguard = await BG.BotGuardClient.create({
    program: challengeResponse.bg_challenge.program,
    globalName: challengeResponse.bg_challenge.global_name,
    globalObj: globalThis
  });
  // #endregion

  // #region WebPO Token Generation
  const webPoSignalOutput: WebPoSignalOutput = [];
  const botguardResponse = await botguard.snapshot({ webPoSignalOutput });
  const requestKey = 'O43z0dpjhgX20SCx4KAo';

  const integrityTokenResponse = await fetch(buildURL('GenerateIT', true), {
    method: 'POST',
    headers: {
      'content-type': 'application/json+protobuf',
      'x-goog-api-key': GOOG_API_KEY,
      'x-user-agent': 'grpc-web-javascript/0.1',
      'user-agent': userAgent
    },
    body: JSON.stringify([requestKey, botguardResponse]),
    dispatcher: options.proxyAgent
  });

  const response = (await integrityTokenResponse.json()) as [
    string,
    number,
    number,
    string
  ];

  if (typeof response[0] !== 'string')
    throw new Error('Could not get integrity token');

  const [integrityToken, estimatedTtlSecs, mintRefreshThreshold] = response;

  if (typeof response[0] !== 'string')
    throw new Error('Could not get integrity token');

  const integrityTokenBasedMinter = await BG.WebPoMinter.create(
    { integrityToken },
    webPoSignalOutput
  );
  // #endregion

  return {
    minter: integrityTokenBasedMinter,
    ttl: estimatedTtlSecs,
    refreshThreshold: mintRefreshThreshold,
    created: Date.now()
  };
}
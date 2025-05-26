/**
 * Node.js 18+ fetch polyfill
 * ESM版node-fetchを使用してfetchをグローバルに設定
 */

// Node.js 18+の場合はネイティブfetchを使用
async function setupFetchPolyfill() {
  if (typeof globalThis.fetch === 'undefined') {
    try {
      // ESM版node-fetchを動的インポート
      const nodeFetch = await import('node-fetch');
      const fetch = nodeFetch.default;
      const { Headers, Request, Response } = nodeFetch;
      
      // グローバルに設定
      (globalThis as any).fetch = fetch;
      (globalThis as any).Headers = Headers;
      (globalThis as any).Request = Request;
      (globalThis as any).Response = Response;
      
      console.log('📡 node-fetch polyfill loaded (ESM)');
    } catch (error) {
      console.warn('⚠️  Failed to load node-fetch polyfill:', error);
      
      // フォールバック: 基本的なfetch実装
      (globalThis as any).fetch = async (url: string | URL, options?: any) => {
        throw new Error(`fetch not available: ${url}`);
      };
    }
  } else {
    console.log('📡 Using native fetch (Node.js 18+)');
  }
}

// 初期化を実行
setupFetchPolyfill().catch(console.error);

export {}; 
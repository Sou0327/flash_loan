import { createClient, RedisClientType } from 'redis';
import { getRedisConfig } from './config';

// キャッシュエントリの型定義
interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

// 統合キャッシュマネージャー
export class CacheManager {
  private redisClient: RedisClientType | null = null;
  private memoryCache = new Map<string, CacheEntry<any>>();
  private config: ReturnType<typeof getRedisConfig>;
  private isRedisConnected = false;

  constructor() {
    this.config = getRedisConfig();
    this.initializeRedis();
  }

  /**
   * Redis接続を初期化
   */
  private async initializeRedis(): Promise<void> {
    if (!this.config.enabled) {
      console.log('📦 Cache: Memory-only mode (Redis disabled)');
      return;
    }

    try {
      this.redisClient = createClient({
        socket: {
          host: this.config.host,
          port: this.config.port,
          reconnectStrategy: (retries) => Math.min(retries * 50, 500)
        },
        password: this.config.password || undefined,
      });

      this.redisClient.on('error', (err) => {
        console.warn('⚠️  Redis connection error:', err.message);
        this.isRedisConnected = false;
      });

      this.redisClient.on('connect', () => {
        console.log('✅ Redis connected successfully');
        this.isRedisConnected = true;
      });

      this.redisClient.on('disconnect', () => {
        console.warn('⚠️  Redis disconnected');
        this.isRedisConnected = false;
      });

      await this.redisClient.connect();

    } catch (error) {
      console.warn('⚠️  Failed to connect to Redis:', error instanceof Error ? error.message : String(error));
      console.log('📦 Falling back to memory-only cache');
      this.redisClient = null;
      this.isRedisConnected = false;
    }
  }

  /**
   * キャッシュからデータを取得
   */
  async get<T>(key: string): Promise<T | null> {
    const prefixedKey = this.getPrefixedKey(key);

    // Redis優先、フォールバックでメモリキャッシュ
    if (this.isRedisConnected && this.redisClient) {
      try {
        const redisValue = await this.redisClient.get(prefixedKey);
        if (redisValue) {
          const parsed = JSON.parse(redisValue) as CacheEntry<T>;
          
          // TTLチェック
          if (this.isExpired(parsed)) {
            await this.redisClient.del(prefixedKey);
            return null;
          }
          
          return parsed.data;
        }
      } catch (error) {
        console.warn(`⚠️  Redis get failed for key ${key}:`, error instanceof Error ? error.message : String(error));
      }
    }

    // メモリキャッシュから取得
    const memoryEntry = this.memoryCache.get(prefixedKey);
    if (memoryEntry) {
      if (this.isExpired(memoryEntry)) {
        this.memoryCache.delete(prefixedKey);
        return null;
      }
      return memoryEntry.data;
    }

    return null;
  }

  /**
   * キャッシュにデータを保存
   */
  async set<T>(key: string, data: T, ttlSeconds?: number): Promise<void> {
    const prefixedKey = this.getPrefixedKey(key);
    const ttl = ttlSeconds || this.config.ttl_seconds;
    const entry: CacheEntry<T> = {
      data,
      timestamp: Date.now(),
      ttl: ttl * 1000 // ミリ秒に変換
    };

    // Redis保存
    if (this.isRedisConnected && this.redisClient) {
      try {
        await this.redisClient.setEx(
          prefixedKey,
          ttl,
          JSON.stringify(entry)
        );
      } catch (error) {
        console.warn(`⚠️  Redis set failed for key ${key}:`, error instanceof Error ? error.message : String(error));
      }
    }

    // メモリキャッシュにも保存（フォールバック用）
    this.memoryCache.set(prefixedKey, entry);

    // メモリキャッシュサイズ制限（1000エントリ）
    if (this.memoryCache.size > 1000) {
      const firstKey = this.memoryCache.keys().next().value;
      if (firstKey) {
        this.memoryCache.delete(firstKey);
      }
    }
  }

  /**
   * キャッシュからデータを削除
   */
  async delete(key: string): Promise<void> {
    const prefixedKey = this.getPrefixedKey(key);

    // Redis削除
    if (this.isRedisConnected && this.redisClient) {
      try {
        await this.redisClient.del(prefixedKey);
      } catch (error) {
        console.warn(`⚠️  Redis delete failed for key ${key}:`, error instanceof Error ? error.message : String(error));
      }
    }

    // メモリキャッシュ削除
    this.memoryCache.delete(prefixedKey);
  }

  /**
   * パターンマッチでキャッシュを削除
   */
  async deletePattern(pattern: string): Promise<void> {
    const prefixedPattern = this.getPrefixedKey(pattern);

    // Redis削除
    if (this.isRedisConnected && this.redisClient) {
      try {
        const keys = await this.redisClient.keys(prefixedPattern);
        if (keys.length > 0) {
          await this.redisClient.del(keys);
        }
      } catch (error) {
        console.warn(`⚠️  Redis deletePattern failed for pattern ${pattern}:`, error instanceof Error ? error.message : String(error));
      }
    }

    // メモリキャッシュ削除
    for (const key of this.memoryCache.keys()) {
      if (key.includes(pattern)) {
        this.memoryCache.delete(key);
      }
    }
  }

  /**
   * キャッシュ統計を取得
   */
  async getStats(): Promise<{
    redisConnected: boolean;
    memoryEntries: number;
    redisEntries?: number;
  }> {
    const stats = {
      redisConnected: this.isRedisConnected,
      memoryEntries: this.memoryCache.size,
      redisEntries: undefined as number | undefined
    };

    if (this.isRedisConnected && this.redisClient) {
      try {
        const info = await this.redisClient.info('keyspace');
        const match = info.match(/keys=(\d+)/);
        stats.redisEntries = match ? parseInt(match[1]) : 0;
      } catch (error) {
        // Redis統計取得失敗は無視
      }
    }

    return stats;
  }

  /**
   * 期限切れチェック
   */
  private isExpired<T>(entry: CacheEntry<T>): boolean {
    return Date.now() - entry.timestamp > entry.ttl;
  }

  /**
   * プレフィックス付きキーを生成
   */
  private getPrefixedKey(key: string): string {
    return `flash_arb:${key}`;
  }

  /**
   * 定期的なメモリキャッシュクリーンアップ
   */
  startCleanupTimer(): void {
    setInterval(() => {
      const now = Date.now();
      let cleanedCount = 0;

      for (const [key, entry] of this.memoryCache.entries()) {
        if (this.isExpired(entry)) {
          this.memoryCache.delete(key);
          cleanedCount++;
        }
      }

      if (cleanedCount > 0) {
        console.log(`🧹 Cleaned ${cleanedCount} expired cache entries`);
      }
    }, 60000); // 1分ごと
  }

  /**
   * 接続を閉じる
   */
  async close(): Promise<void> {
    if (this.redisClient) {
      try {
        await this.redisClient.quit();
      } catch (error) {
        console.warn('⚠️  Error closing Redis connection:', error instanceof Error ? error.message : String(error));
      }
    }
    this.memoryCache.clear();
  }
}

// シングルトンインスタンス
let cacheManagerInstance: CacheManager | null = null;

export const getCacheManager = (): CacheManager => {
  if (!cacheManagerInstance) {
    cacheManagerInstance = new CacheManager();
    cacheManagerInstance.startCleanupTimer();
  }
  return cacheManagerInstance;
};

// 価格キャッシュ専用ヘルパー関数
export const getPriceFromCache = async (tokenAddress: string): Promise<number | null> => {
  const cache = getCacheManager();
  return await cache.get<number>(`price:${tokenAddress.toLowerCase()}`);
};

export const setPriceToCache = async (tokenAddress: string, price: number, ttlSeconds = 30): Promise<void> => {
  const cache = getCacheManager();
  await cache.set(`price:${tokenAddress.toLowerCase()}`, price, ttlSeconds);
};

// ETH価格キャッシュ専用
export const getETHPriceFromCache = async (): Promise<number | null> => {
  const cache = getCacheManager();
  return await cache.get<number>('eth_price_usd');
};

export const setETHPriceToCache = async (price: number, ttlSeconds = 30): Promise<void> => {
  const cache = getCacheManager();
  await cache.set('eth_price_usd', price, ttlSeconds);
}; 
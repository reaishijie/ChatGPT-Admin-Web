import { redis } from '../redis/client';
import { Model } from './typing';
import md5 from 'spark-md5';
import { UserDAL } from './user';

export class AccessControlDAL {
  constructor(
    /* 邮箱或 IP */
    private emailOrIP: string,
    private isIP = !emailOrIP.includes('@')
  ) {}

  /**
   * 新建一个会话令牌
   */
  async newSessionToken(): Promise<string | null> {
    if (this.isIP) return null;

    const token = md5.hash(`${this.emailOrIP}:${new Date()}`);

    const sessionToken: Model.SessionToken = {
      createdAt: Date.now(),

      isRevoked: false,
      userEmail: this.emailOrIP,
    };

    await redis.hmset(`sessionToken:${token}`, sessionToken);
    await redis.expire(`sessionToken:${token}`, 24 * 60 * 60); // Expire in 1 day

    return token;
  }

  /**
   * 验证会话令牌是否有效
   * @param token
   * @return 返回用户邮箱用于效验
   */
  async validateSessionToken(token: string): Promise<string | null> {
    if (this.isIP) return null;

    const sessionToken = await redis.hgetall<Model.SessionToken>(
      `sessionToken:${token.trim()}`
    );

    if (!sessionToken) return null;
    if (sessionToken.isRevoked) return null;

    await redis.expire(`sessionToken:${token.trim()}`, 24 * 60 * 60); // Expire in 1 day
    return sessionToken.userEmail;
  }

  /**
   * 获取该用户在三个小时内每次请求的时间戳
   * Free : 10 requests per hour 前端截取最后一个小时进行判断
   * Pro : 50 requests per three hour
   * Premium : No limit in requests until 100 requests in three hours when speed limit will be imposed
   * @return 返回时间戳数组, 按升序排列
   */
  async getRequestsTimeStamp(): Promise<number[]> {
    const key = `limit:${this.emailOrIP}`;
    const user = new UserDAL(this.emailOrIP);
    const plan = await user.getPlan();
    if (plan === 'free')
      await redis.zremrangebyscore(key, 0, Date.now() - 60 * 60 * 1000);
    // 移除所有过期的时间戳 ie. 3 hours ago
    else await redis.zremrangebyscore(key, 0, Date.now() - 3 * 60 * 60 * 1000);

    return await redis.zrange<number[]>(key, 0, -1);
  }

  /**
   * 添加新的请求时间戳, 用来限制请求速率, 是否被添加由上层判断
   * @return 返回该时间戳
   */
  async newRequest(): Promise<number> {
    const key = `limit:${this.emailOrIP}`;
    const timestamp = Date.now();
    // add at the end of requestsTimestamp
    await redis.zadd(key, {
      member: timestamp,
      score: timestamp,
    });
    return timestamp;
  }

  static async getRequestsTimeStampsOf(
    ...emailOrIP: string[]
  ): Promise<number[][]> {
    const pipeline = redis.pipeline();

    emailOrIP.forEach(emailOrIP => {
      pipeline.zrange<number[]>(`limit:${emailOrIP}`, 0, -1);
    });

    return await pipeline.exec();
  }

  async resetLimit() {
    const key = `limit:${this.emailOrIP}`;
    await redis.zremrangebyrank(key, 0, -1);

    return await redis.zrange<number[]>(key, 0, -1);
  }
}
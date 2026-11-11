import { forEachBounded, Semaphore } from './semaphore';

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('Semaphore', () => {
  it('lets at most limit holders in, and passes permits to waiters in arrival order', async () => {
    const limiter = new Semaphore(2);
    const first = await limiter.acquire();
    const second = await limiter.acquire();
    const order: string[] = [];
    const third = limiter.acquire().then((release) => { order.push('third'); return release; });
    const fourth = limiter.acquire().then((release) => { order.push('fourth'); return release; });
    await tick();
    expect([limiter.inFlight, limiter.waiting, order]).toEqual([2, 2, []]);
    first();
    first(); // a second release of the same permit changes nothing
    await tick();
    expect([limiter.inFlight, limiter.waiting, order]).toEqual([2, 1, ['third']]);
    second();
    (await third)();
    (await fourth)();
    expect([limiter.inFlight, limiter.waiting]).toEqual([0, 0]);
  });

  it('drops an aborted waiter without taking a permit', async () => {
    const limiter = new Semaphore(1);
    const held = await limiter.acquire();
    const controller = new AbortController();
    const waiting = limiter.acquire(controller.signal);
    controller.abort(new Error('worker shutdown'));
    await expect(waiting).rejects.toThrow('worker shutdown');
    expect(limiter.waiting).toBe(0);
    held();
    expect(limiter.inFlight).toBe(0);
    await expect(limiter.acquire(controller.signal)).rejects.toThrow('worker shutdown');
  });

  it('releases the permit when the call fails', async () => {
    const limiter = new Semaphore(1);
    await expect(limiter.run(async () => { throw new Error('call failed'); })).rejects.toThrow('call failed');
    expect(limiter.inFlight).toBe(0);
    await expect(limiter.run(async () => 'next')).resolves.toBe('next');
  });

  it('refuses a limit below one', () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(1.5)).toThrow();
  });
});

describe('forEachBounded', () => {
  it('runs at most limit tasks at once, in item order', async () => {
    let running = 0;
    let peak = 0;
    const started: number[] = [];
    await forEachBounded([1, 2, 3, 4, 5], 2, async (item) => {
      started.push(item);
      running += 1;
      peak = Math.max(peak, running);
      await tick();
      running -= 1;
    });
    expect(peak).toBe(2);
    expect(started).toEqual([1, 2, 3, 4, 5]);
  });

  it('starts nothing new after a failure, waits for the running task, then throws the first failure', async () => {
    const finished: number[] = [];
    await expect(forEachBounded([1, 2, 3, 4], 2, async (item) => {
      if (item === 1) throw new Error('first failure');
      await tick();
      finished.push(item);
    })).rejects.toThrow('first failure');
    expect(finished).toEqual([2]);
  });
});

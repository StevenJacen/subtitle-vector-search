import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

test.describe('local video workbench', () => {
  test('reviews eight-at-a-time candidates and produces a silent video', async ({ page }, testInfo) => {
    test.slow()
    const browserErrors: string[] = []
    page.on('console', message => {
      if (message.type() === 'error') browserErrors.push(message.text())
    })
    page.on('pageerror', error => browserErrors.push(error.message))
    await page.goto('/')

    await expect(page.getByText('台词视频工作台')).toBeVisible()
    await expect(page.getByText('服务就绪')).toBeVisible()
    await expect(page.getByText('Supabase')).toBeVisible()
    await expect(page.getByText('Vecteezy')).toBeVisible()

    const theme = `穿过黑暗迎向黎明 ${testInfo.project.name}`
    await createTask(page, theme, 5, testInfo.project.name === 'tablet' ? '16:9' : '9:16')
    await expect(page.getByRole('heading', { name: theme })).toBeVisible()
    await expect(page.getByTestId('passage-cue')).toHaveCount(5)
    await expect(page.getByTestId('caption-en')).toHaveCount(5)
    await expect(page.getByTestId('candidate-grid-0').getByTestId('candidate-card')).toHaveCount(8)

    await page.getByTestId('candidate-grid-0').locator('..').getByRole('button', { name: '加载更多候选' }).click()
    await expect(page.getByTestId('candidate-grid-0').getByTestId('candidate-card')).toHaveCount(16)
    await assertUniqueResources(page, 0)

    await confirmEveryScene(page, 5)
    const produce = page.getByRole('button', { name: '开始制作' })
    await expect(produce).toBeEnabled()
    await assertNoHorizontalOverflow(page)
    await assertNoCardOverlap(page)
    await page.screenshot({ path: testInfo.outputPath('review.png'), fullPage: true })

    await produce.click()
    await expect(page.getByLabel('制作进度')).toBeVisible()
    await assertFixedProgressGeometry(page)
    await expect(page.getByRole('heading', { name: '成片与完整性' })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('无音轨')).toBeVisible()
    const player = page.getByLabel('成片预览')
    await expect(player).toBeVisible()
    await expect(player).toHaveJSProperty('muted', true)

    const endpoint = await player.getAttribute('src')
    expect(endpoint).toMatch(/^\/api\/tasks\/[0-9a-f-]+\/final$/)
    const ranged = await page.request.get(endpoint!, { headers: { range: 'bytes=0-99' } })
    expect(ranged.status()).toBe(206)
    expect(ranged.headers()['content-range']).toMatch(/^bytes 0-99\/\d+$/)
    expect((await ranged.body()).byteLength).toBe(100)

    await assertNoHorizontalOverflow(page)
    await page.screenshot({ path: testInfo.outputPath('completed.png'), fullPage: true })

    const fixture = testInfo.project.name === 'tablet' ? 'landscape' : 'portrait'
    const probe = JSON.parse(execFileSync('ffprobe', [
      '-v', 'error', '-show_streams', '-of', 'json',
      resolve('artifacts/e2e/.workbench-fixtures', fixture, 'final.mp4'),
    ], { encoding: 'utf8' })) as { streams: Array<Record<string, unknown>> }
    expect(probe.streams.filter(stream => stream.codec_type === 'audio')).toHaveLength(0)
    expect(probe.streams.filter(stream => stream.codec_type === 'video')).toEqual([
      expect.objectContaining({ codec_name: 'h264', pix_fmt: 'yuv420p', r_frame_rate: '30/1' }),
    ])
    expect(await page.locator('vite-error-overlay').count()).toBe(0)
    expect(browserErrors).toEqual([])
  })

  test('supports ten scenes and keeps task history navigable', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'Boundary coverage runs once on desktop')
    await page.goto('/')

    await createTask(page, '十个连续场景测试', 10, '16:9')
    await expect(page.getByTestId('passage-cue')).toHaveCount(10)
    await expect(page.locator('.scene-review')).toHaveCount(10)
    await expect(page.locator('.candidate-card')).toHaveCount(80)
    await expect(page.getByLabel(/穿过黑暗迎向黎明 desktop/)).toBeVisible()
    await page.getByLabel(/穿过黑暗迎向黎明 desktop/).click()
    await expect(page.getByRole('heading', { name: '穿过黑暗迎向黎明 desktop' })).toBeVisible()
    await assertNoHorizontalOverflow(page)
  })

  test('searches the subtitle library and creates from the exact ranked result', async ({ page }, testInfo) => {
    const browserErrors = trackBrowserErrors(page)
    await page.goto('/')
    await page.getByRole('tab', { name: '字幕库' }).click()

    await expect(page.getByLabel('字幕库统计')).toContainText('3 部电影')
    await expect(page.getByLabel('字幕库统计')).toContainText('4 条轨道')
    await page.getByRole('searchbox', { name: '搜索台词' }).fill('hope is a good thing')
    await page.getByRole('button', { name: '搜索台词' }).click()

    const result = page.getByTestId('subtitle-result-4101-27')
    await expect(result).toBeVisible()
    await expect(result).toContainText('The Shawshank Redemption')
    await expect(result).toContainText('1994')
    await expect(result).toContainText('00:06:12.000 --> 00:06:20.400')
    await expect(result).toContainText('Hope is a good thing, maybe the best of things.')
    await expect(result).toContainText('综合排名 1')
    await expect(result).toContainText('语义排名 1')
    await expect(result).toContainText('全文排名 2')
    await assertNoHorizontalOverflow(page)

    await result.getByRole('button', { name: '用此台词制作' }).click()
    await expect(page.getByRole('tab', { name: '视频制作' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.movie-line')).toContainText('The Shawshank Redemption')
    await expect(page.locator('.passage-stats')).toContainText('轨道 4101')
    await expect(page.getByTestId('cue-index').filter({ hasText: '#813' })).toHaveCount(1)

    await page.getByRole('tab', { name: '字幕库' }).click()
    await page.getByRole('searchbox', { name: '搜索台词' }).fill('希望与自由')
    const normalizedResponse = page.waitForResponse(response => (
      response.url().endsWith('/api/subtitles/search') && response.request().method() === 'POST'
    ))
    await page.getByRole('button', { name: '搜索台词' }).click()
    const normalized = await (await normalizedResponse).json() as {
      originalQuery: string
      normalizedQuery: string
      warning: string | null
    }
    expect(normalized).toMatchObject({
      originalQuery: '希望与自由',
      normalizedQuery: 'hope and freedom',
      warning: null,
    })
    await expect(page.getByTestId('subtitle-result-4101-27')).toBeVisible()
    await assertNoHorizontalOverflow(page)
    expect(await page.locator('vite-error-overlay').count()).toBe(0)
    expect(browserErrors).toEqual([])
    await page.screenshot({ path: testInfo.outputPath('subtitle-library.png'), fullPage: true })
  })

  test('runs automatic and manual subtitle sync and cooperatively stops an active job', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'Synchronization lifecycle coverage runs once on desktop')
    const browserErrors = trackBrowserErrors(page)
    await page.goto('/')
    await page.getByRole('tab', { name: '字幕库' }).click()
    await page.getByRole('button', { name: '同步新电影' }).click()
    const dialog = page.getByRole('dialog', { name: '同步新电影' })

    await dialog.getByRole('button', { name: '继续' }).click()
    await expect(dialog.getByText('确认开始自动同步？')).toBeVisible()
    await dialog.getByRole('button', { name: '开始自动同步' }).click()
    await expect(dialog.getByText('The Matrix (1999)')).toBeVisible()
    await expect(dialog.getByText('已尝试 1')).toBeVisible()
    await expect(dialog.getByText('配额已用尽', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Provider quota reached; rerun later')).toBeVisible()

    await dialog.getByRole('button', { name: '返回' }).click()
    await dialog.locator('.sync-mode-control label').filter({ hasText: /^手动$/ }).click()
    await expect(dialog.getByRole('radio', { name: '手动' })).toBeChecked()
    await dialog.getByRole('button', { name: '导入电影' }).click()
    await expect(dialog.getByRole('alert')).toContainText('请填写片名')
    await dialog.getByLabel('片名').fill('The Matrix')
    await dialog.getByLabel('上映年份').fill('1999')
    await dialog.getByLabel('IMDb ID').fill('matrix')
    await dialog.getByRole('button', { name: '导入电影' }).click()
    await expect(dialog.getByRole('alert')).toContainText('IMDb ID 必须以 tt 开头并包含数字')
    await dialog.getByLabel('IMDb ID').fill('tt0133093')
    await dialog.getByRole('button', { name: '导入电影' }).click()
    await expect(dialog.getByText('The Matrix (1999)')).toBeVisible()
    await expect(dialog.getByText('已完成', { exact: true })).toBeVisible()
    await expect(dialog.getByText('已完成 1')).toBeVisible()

    const automaticMode = dialog.getByRole('radio', { name: '自动' })
    await automaticMode.focus()
    await automaticMode.press('Space')
    await expect(automaticMode).toBeChecked()
    await dialog.getByRole('button', { name: '继续' }).click()
    await dialog.getByRole('button', { name: '开始自动同步' }).click()
    await expect(dialog.getByText('已有同步任务正在运行')).toBeVisible()
    await dialog.getByRole('button', { name: '停止同步' }).click()
    await expect(dialog.getByText('已停止', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Stopped by operator')).toBeVisible()

    await assertNoHorizontalOverflow(page)
    expect(await page.locator('vite-error-overlay').count()).toBe(0)
    expect(browserErrors).toEqual([])
  })

  test('recovers a retryable production task', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'Recovery coverage runs once on desktop')
    test.slow()
    await page.goto('/')
    await createTask(page, '失败恢复测试', 5, '9:16')
    await confirmEveryScene(page, 5)
    await page.getByRole('button', { name: '开始制作' }).click()

    await expect(page.getByRole('alert').filter({ hasText: '测试渲染已中断' })).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: '恢复任务' }).click()
    await expect(page.getByRole('heading', { name: '成片与完整性' })).toBeVisible({ timeout: 20_000 })
  })
})

async function createTask(page: Page, theme: string, sceneCount: number, aspectRatio: '9:16' | '16:9') {
  await page.getByLabel('视频主题').fill(theme)
  await page.getByLabel(aspectRatio === '9:16' ? '竖屏 9:16' : '横屏 16:9').check()
  for (let count = 5; count < sceneCount; count += 1) {
    await page.getByLabel('增加场景').click()
  }
  await page.getByRole('button', { name: '创建视频任务' }).click()
  await expect(page.getByRole('heading', { name: theme })).toBeVisible({ timeout: 15_000 })
}

async function confirmEveryScene(page: Page, sceneCount: number) {
  const scenes = page.locator('.scene-review')
  await expect(scenes).toHaveCount(sceneCount)
  for (let index = 0; index < sceneCount; index += 1) {
    const firstCard = scenes.nth(index).getByTestId('candidate-card').first()
    await firstCard.getByRole('button', { name: /^选择/ }).click()
    await firstCard.getByRole('button', { name: /^确认/ }).click()
    await expect(firstCard).toHaveAttribute('data-confirmed', 'true')
  }
}

async function assertUniqueResources(page: Page, sceneIndex: number) {
  const titles = await page.getByTestId(`candidate-grid-${sceneIndex}`)
    .locator('.candidate-card__title')
    .evaluateAll(nodes => nodes.map(node => node.textContent))
  expect(new Set(titles).size).toBe(titles.length)
}

async function assertFixedProgressGeometry(page: Page) {
  const widths = await page.locator('[data-progress-step]').evaluateAll(nodes => (
    nodes.map(node => Math.round(node.getBoundingClientRect().width))
  ))
  expect(widths).toHaveLength(7)
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1)
}

async function assertNoHorizontalOverflow(page: Page) {
  const geometry = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }))
  expect(geometry.document).toBeLessThanOrEqual(geometry.viewport)
  expect(geometry.body).toBeLessThanOrEqual(geometry.viewport)
}

async function assertNoCardOverlap(page: Page) {
  const overlapping = await page.locator('.candidate-grid:visible').first().evaluate(grid => {
    const cards = [...grid.querySelectorAll('.candidate-card')].map(card => card.getBoundingClientRect())
    return cards.some((left, index) => cards.slice(index + 1).some(right => (
      Math.min(left.right, right.right) - Math.max(left.left, right.left) > 1
      && Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 1
    )))
  })
  expect(overlapping).toBe(false)
}

function trackBrowserErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', error => errors.push(error.message))
  return errors
}

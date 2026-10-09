#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const output = resolve(import.meta.dirname, '..', 'cdk.out')
const files = (await readdir(output)).filter(name => name.endsWith('.template.json'))
assert.ok(files.length >= 1)
for (const file of files) {
  const template = JSON.parse(await readFile(resolve(output, file), 'utf8'))
  const resources = Object.values(template.Resources ?? {})
  const text = JSON.stringify(template)
  assert.equal(resources.some(resource => resource.Type === 'AWS::CloudFront::Distribution'), false)
  assert.equal(resources.some(resource => resource.Type === 'AWS::Budgets::BudgetsAction'), false)
  assert.doesNotMatch(text, /Action":"\*"|Action":\[[^\]]*"\*"/)
  assert.doesNotMatch(text, /PubliclyAccessible":true/)
  assert.doesNotMatch(text, /AssignPublicIp":"ENABLED/)
}
process.stdout.write(`IaC policy verification passed for ${files.length} template(s)\n`)

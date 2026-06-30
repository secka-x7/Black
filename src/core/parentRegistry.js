// Black Omega — Parent Network Registry
// Central coordinator for all 10 parent network real operations.
// Called by Fortress phases and Dominion. Delegates to per-parent modules.
import { getConfig, setConfig } from '../db.js'
import { getRecentGaps } from './price.js'

const PARENT_MODULES = ['xrpl', 'stellar', 'ethereum', 'solana', 'bnb', 'cosmos', 'polkadot', 'avalanche', 'cbdc', 'swift']

async function loadParent(name) {
  return import(`../parents/${name}.js`)
}

export async function insertAllOffers() {
  const results = {}
  for (const name of PARENT_MODULES) {
    try {
      const mod = await loadParent(name)
      if (mod.insertOffers) results[name] = await mod.insertOffers()
    } catch (e) { results[name] = { error: e.message?.slice(0, 60) } }
  }
  return results
}

export async function cascadeDepth() {
  const results = {}
  for (const name of PARENT_MODULES) {
    try {
      const mod = await loadParent(name)
      if (mod.cascadeDepth) results[name] = await mod.cascadeDepth()
    } catch (e) { results[name] = { error: e.message?.slice(0, 60) } }
  }
  return results
}

export async function dominateCorridors() {
  const results = {}
  for (const name of PARENT_MODULES) {
    try {
      const mod = await loadParent(name)
      if (mod.dominateCorridors) results[name] = await mod.dominateCorridors()
    } catch (e) { results[name] = { error: e.message?.slice(0, 60) } }
  }
  return results
}

export async function deployLiquidity() {
  const results = {}
  for (const name of PARENT_MODULES) {
    try {
      const mod = await loadParent(name)
      if (mod.deployLiquidity) results[name] = await mod.deployLiquidity()
    } catch (e) { results[name] = { error: e.message?.slice(0, 60) } }
  }
  return results
}

export async function detectInstitutional() {
  const results = {}
  for (const name of PARENT_MODULES) {
    try {
      const mod = await loadParent(name)
      if (mod.detectInstitutional) results[name] = await mod.detectInstitutional()
    } catch (e) { results[name] = { error: e.message?.slice(0, 60) } }
  }
  return results
}

// Dominion: real competitor detection from live gap/spread data
export async function getCompetitorSignals() {
  const gaps = getRecentGaps()
  const signals = []
  for (const gap of gaps.slice(0, 10)) {
    signals.push({
      parent: gap.parent,
      corridor: gap.pair,
      competitorDetected: gap.spread > 0.2,
      minWinningPrice: gap.spread * 0.98,
      newCorridor: false,
    })
  }
  return signals
}

export async function repriceCorridor(parent, corridor, price) {
  setConfig(`reprice_${parent}_${corridor}`, String(price))
  return { ok: true }
}

export function getParentStatus() {
  const status = {}
  for (const name of PARENT_MODULES) status[name] = getConfig(`status_${name}`) || 'connecting'
  return status
}

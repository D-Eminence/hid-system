import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CommercialLayout } from '../features/commercial/CommercialLayout'
import { products } from '../features/commercial/catalog'
import { invokeApiFunction } from '../lib/functionApi'

type Price = { product_slug:string; context:string; visibility:string; amount_minor:number|null; currency:string; billing_period:string|null; unit:string|null }
export default function Pricing() {
  const [prices, setPrices] = useState<Price[]>([])
  useEffect(() => {
    void invokeApiFunction<{ data: Price[] }>('public-pricing', { method: 'GET' }, 'Pricing could not be loaded right now.')
      .then(result => setPrices(result.data ?? []))
      .catch(() => setPrices([]))
  }, [])
  const display = (price?: Price) => {
    if (!price || ['contact_sales','custom_quote','hidden'].includes(price.visibility)) return price?.visibility === 'hidden' ? 'Pricing available on request' : price?.visibility === 'custom_quote' ? 'Custom quote' : 'Contact sales'
    const amount = new Intl.NumberFormat('en-NG', { style:'currency', currency:price.currency || 'NGN', maximumFractionDigits:0 }).format((price.amount_minor ?? 0) / 100)
    return `${price.visibility === 'starting_from' ? 'Starting from ' : ''}${amount}${price.unit ? ` / ${price.unit}` : price.billing_period ? ` / ${price.billing_period}` : ''}`
  }
  return <CommercialLayout><main><section className="commercial-hero"><div className="commercial-shell"><div className="commercial-eyebrow">Modular pricing</div><h1>Start with what you need. Add more when you&apos;re ready.</h1><p>HID supports core, add-on, standalone, setup, migration-project, usage-based, and custom enterprise pricing. Published amounts are controlled by Platform Admin.</p></div></section><section className="commercial-section"><div className="commercial-shell"><div className="commercial-grid">{products.filter(p => p.slug !== 'identity').map(product => { const productPrices = prices.filter(price => price.product_slug === product.slug); return <article className="commercial-card" key={product.slug}><div className="commercial-badges">{product.badges.map(b => <span className="commercial-badge" key={b}>{b}</span>)}</div><h3>{product.name}</h3>{productPrices.length ? productPrices.map(price => <p key={price.context}><strong>{price.context.replace('_',' ')}:</strong> {display(price)}</p>) : <p><strong>Contact sales</strong></p>}<Link className="commercial-button" to={`/products/${product.slug}`}>View product</Link></article>})}</div></div></section></main></CommercialLayout>
}

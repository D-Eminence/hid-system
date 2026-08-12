import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import { HIDLogo } from '../../components/HIDLogo'
import { PROVIDER_ACCESS_HREF } from '../../lib/providerAccess'
import './Commercial.css'

export function CommercialLayout({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const [productsOpen, setProductsOpen] = useState(false)
  const links = [['Why HID', '/#why-hid'], ['Ecosystem', '/#ecosystem'], ['How it Works', '/#how-it-works'], ['Security', '/#security']]
  const productLinks = [['HID Identity', 'identity'], ['HID EHR', 'ehr'], ['HID Laboratory', 'laboratory'], ['HID Pharmacy', 'pharmacy'], ['HID Migrate', 'migrate'], ['HID Outreach', 'outreach']]
  return <div className="commercial-page">
    <style>{`.commercial-product-trigger{border:0;background:transparent;color:var(--t2);font:inherit;font-size:14px;font-weight:600;padding:12px 0}.commercial-product-menu{position:absolute;top:100%;left:-14px;width:240px;padding:8px;display:grid;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);box-shadow:var(--shadow-md)}.commercial-product-menu a{padding:9px 11px;border-radius:var(--r-md)}.commercial-mobile button{border:0;background:transparent;text-align:left;padding:11px;color:var(--t2);font-weight:700}.commercial-mobile-products{display:grid;padding-left:14px}`}</style>
    <header className="commercial-header"><div className="commercial-shell commercial-nav">
      <Link to="/" aria-label="HID home"><HIDLogo size="sm" /></Link>
      <nav className="commercial-links"><div style={{position:'relative'}} onMouseEnter={()=>setProductsOpen(true)} onMouseLeave={()=>setProductsOpen(false)}><button type="button" className="commercial-product-trigger" aria-expanded={productsOpen} onClick={()=>setProductsOpen(value=>!value)}>Products <span>▾</span></button>{productsOpen&&<div className="commercial-product-menu">{productLinks.map(([label,slug])=><Link key={slug} to={`/products/${slug}`}>{label}</Link>)}<Link to="/products">View all products →</Link></div>}</div>{links.map(([label, href]) => <Link key={label} to={href}>{label}</Link>)}<a className="commercial-button" href={PROVIDER_ACCESS_HREF}>Hospital / Provider Access</a></nav>
      <button className="commercial-button commercial-menu" onClick={() => setOpen(value => !value)} aria-expanded={open}>Menu</button>
    </div>{open && <div className="commercial-shell commercial-mobile"><button type="button" onClick={()=>setProductsOpen(value=>!value)}>Products {productsOpen?'▴':'▾'}</button>{productsOpen&&<div className="commercial-mobile-products">{productLinks.map(([label,slug])=><Link key={slug} to={`/products/${slug}`} onClick={()=>setOpen(false)}>{label}</Link>)}</div>}{links.map(([label, href]) => <Link key={label} to={href} onClick={() => setOpen(false)}>{label}</Link>)}<Link to="/patient">Get Your HID</Link><a href="mailto:hello@healthidentitydirectory.com?subject=Book a Demo">Book a Demo</a><a href={PROVIDER_ACCESS_HREF}>Hospital / Provider Access</a></div>}</header>
    {children}
    <footer className="commercial-footer"><div className="commercial-shell">HID Technologies · One Health Identity. Connected Care. Accessible Records.</div></footer>
  </div>
}

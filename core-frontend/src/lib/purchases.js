// src/lib/purchases.js
import { api } from './api';

export const listPurchases = async (params) => {
  const { data } = await api.get('/purchases', { params });
  return data || [];
};
export const createPurchase = async (payload) => {
  const { data } = await api.post('/purchases', payload);
  return data;
};
export const deletePurchase = async (id) => {
  await api.delete(`/purchases/${id}`);
};

export const listVendors = async (q='') => {
  const { data } = await api.get('/vendors', { params: { q, limit: 1000 } });
  return data || [];
};

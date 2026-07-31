"use strict";

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

class DeadlineQueue {
  constructor() {
    this._heap = [];
    this._indexByKey = new Map();
  }

  get size() {
    return this._heap.length;
  }

  clear() {
    this._heap.length = 0;
    this._indexByKey.clear();
  }

  peek() {
    return this._heap.length > 0 ? { ...this._heap[0] } : null;
  }

  schedule(key, dueAtMs, payload = null) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) {
      throw new Error("DeadlineQueue.schedule requires a non-empty key");
    }
    const normalizedDueAtMs = Math.max(0, toFiniteNumber(dueAtMs, 0));
    const existingIndex = this._indexByKey.get(normalizedKey);
    if (existingIndex !== undefined) {
      const entry = this._heap[existingIndex];
      const previousDueAtMs = entry.dueAtMs;
      entry.dueAtMs = normalizedDueAtMs;
      entry.payload = payload;
      if (normalizedDueAtMs < previousDueAtMs) {
        this._bubbleUp(existingIndex);
      } else if (normalizedDueAtMs > previousDueAtMs) {
        this._bubbleDown(existingIndex);
      }
      return { ...entry };
    }

    const entry = {
      key: normalizedKey,
      dueAtMs: normalizedDueAtMs,
      payload,
    };
    this._heap.push(entry);
    const index = this._heap.length - 1;
    this._indexByKey.set(normalizedKey, index);
    this._bubbleUp(index);
    return { ...entry };
  }

  remove(key) {
    const normalizedKey = String(key || "").trim();
    const index = this._indexByKey.get(normalizedKey);
    if (index === undefined) {
      return false;
    }

    const lastIndex = this._heap.length - 1;
    this._swap(index, lastIndex);
    const removed = this._heap.pop();
    this._indexByKey.delete(normalizedKey);
    if (index < this._heap.length) {
      this._bubbleUp(index);
      this._bubbleDown(index);
    }
    return Boolean(removed);
  }

  popDue(nowMs) {
    const head = this._heap[0];
    if (!head || head.dueAtMs > toFiniteNumber(nowMs, 0)) {
      return null;
    }
    const result = { ...head };
    this.remove(head.key);
    return result;
  }

  _compare(left, right) {
    if (left.dueAtMs !== right.dueAtMs) {
      return left.dueAtMs - right.dueAtMs;
    }
    return left.key.localeCompare(right.key);
  }

  _swap(leftIndex, rightIndex) {
    if (leftIndex === rightIndex) {
      return;
    }
    const left = this._heap[leftIndex];
    const right = this._heap[rightIndex];
    this._heap[leftIndex] = right;
    this._heap[rightIndex] = left;
    this._indexByKey.set(right.key, leftIndex);
    this._indexByKey.set(left.key, rightIndex);
  }

  _bubbleUp(startIndex) {
    let index = startIndex;
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this._compare(this._heap[parentIndex], this._heap[index]) <= 0) {
        break;
      }
      this._swap(parentIndex, index);
      index = parentIndex;
    }
  }

  _bubbleDown(startIndex) {
    let index = startIndex;
    while (index < this._heap.length) {
      const leftIndex = (index * 2) + 1;
      const rightIndex = leftIndex + 1;
      let smallestIndex = index;
      if (
        leftIndex < this._heap.length &&
        this._compare(this._heap[leftIndex], this._heap[smallestIndex]) < 0
      ) {
        smallestIndex = leftIndex;
      }
      if (
        rightIndex < this._heap.length &&
        this._compare(this._heap[rightIndex], this._heap[smallestIndex]) < 0
      ) {
        smallestIndex = rightIndex;
      }
      if (smallestIndex === index) {
        break;
      }
      this._swap(index, smallestIndex);
      index = smallestIndex;
    }
  }
}

module.exports = {
  DeadlineQueue,
};



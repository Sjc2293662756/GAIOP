/**
 * TimeUtils.js
 * 
 * 时间工具类
 * 
 * 提供时间相关的工具方法，包括时间戳处理、日期格式化、时间范围解析等功能。
 * 
 * 修改日期：2026-04-16
 */
const logger = require('./logger');

/**
 * TimeUtils 类
 * 时间工具类，提供静态方法处理时间相关操作
 */
class TimeUtils {
  /**
   * 将时间戳向下取整到分钟
   * 
   * @param {number} timestamp - 时间戳（秒）
   * @returns {number} - 取整后的时间戳
   */
  static floorToMinute(timestamp) {
    return Math.floor(Number(timestamp || 0) / 60) * 60;
  }

  /**
   * 获取指定天数偏移后的当天开始时间
   * 
   * @param {number} offsetDays - 天数偏移（负数表示过去，正数表示未来）
   * @returns {number} - 当天开始时间戳（秒）
   */
  static getDayStart(offsetDays = 0) {
    const date = new Date();
    date.setDate(date.getDate() + offsetDays);
    date.setHours(0, 0, 0, 0);
    return Math.floor(date.getTime() / 1000);
  }

  /**
   * 获取指定天数偏移后的当天结束时间（排他）
   * 
   * @param {number} offsetDays - 天数偏移
   * @returns {number} - 当天结束时间戳（秒）
   */
  static getDayEndExclusive(offsetDays = 0) {
    return this.getDayStart(offsetDays + 1);
  }

  /**
   * 获取昨天开始时间
   * 
   * @returns {number} - 昨天开始时间戳（秒）
   */
  static getYesterdayStart() {
    const start = this.getDayStart(-1);
    logger.info('Yesterday start:', this.formatDate(start));
    return start;
  }

  /**
   * 获取昨天结束时间
   * 
   * @returns {number} - 昨天结束时间戳（秒）
   */
  static getYesterdayEnd() {
    const end = this.getDayEndExclusive(-1);
    logger.info('Yesterday end:', this.formatDate(end));
    return end;
  }

  /**
   * 获取今天开始时间
   * 
   * @returns {number} - 今天开始时间戳（秒）
   */
  static getTodayStart() {
    return this.getDayStart(0);
  }

  /**
   * 获取今天结束时间
   * 
   * @returns {number} - 今天结束时间戳（秒）
   */
  static getTodayEnd() {
    return this.getDayEndExclusive(0);
  }

  /**
   * 获取当前时间（向下取整到分钟）
   * 
   * @returns {number} - 当前时间戳（秒）
   */
  static getNowMinute() {
    return this.floorToMinute(Math.floor(Date.now() / 1000));
  }

  /**
   * 获取相对时间范围
   * 
   * @param {number} seconds - 相对秒数
   * @returns {object} - 时间范围对象 {start, end}
   */
  static getRelativeRange(seconds) {
    const end = this.getNowMinute();
    return {
      start: end - Number(seconds),
      end
    };
  }

  /**
   * 规范化时间范围（将开始和结束时间都向下取整到分钟）
   * 
   * @param {number} start - 开始时间戳
   * @param {number} end - 结束时间戳
   * @returns {object} - 规范化后的时间范围对象
   */
  static normalizeRange(start, end) {
    return {
      start: this.floorToMinute(start),
      end: this.floorToMinute(end)
    };
  }

  /**
   * 将日期对象转换为时间戳
   * 
   * @param {Date|string} date - 日期对象或日期字符串
   * @returns {number} - 时间戳（秒）
   */
  static getTimestamp(date) {
    return Math.floor(new Date(date).getTime() / 1000);
  }

  /**
   * 将时间戳转换为日期对象
   * 
   * @param {number} timestamp - 时间戳（秒）
   * @returns {Date} - 日期对象
   */
  static getDateFromTimestamp(timestamp) {
    return new Date(timestamp * 1000);
  }

  /**
   * 格式化日期为指定格式
   * 
   * @param {number} timestamp - 时间戳（秒）
   * @param {string} format - 格式字符串，支持 YYYY、MM、DD、HH、mm、ss
   * @returns {string} - 格式化后的日期字符串
   */
  static formatDate(timestamp, format = 'YYYY-MM-DD HH:mm:ss') {
    const date = this.getDateFromTimestamp(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');

    return format
      .replace('YYYY', year)
      .replace('MM', month)
      .replace('DD', day)
      .replace('HH', hours)
      .replace('mm', minutes)
      .replace('ss', seconds);
  }

  /**
   * 解析中文数字
   * 
   * @param {string} rawValue - 中文数字字符串
   * @returns {number|null} - 解析后的数字或null
   */
  static parseChineseNumber(rawValue) {
    const text = String(rawValue || '').trim();
    if (!text) {
      return null;
    }

    if (/^\d+$/.test(text)) {
      return Number(text);
    }

    const digitMap = {
      '零': 0,
      '一': 1,
      '二': 2,
      '两': 2,
      '三': 3,
      '四': 4,
      '五': 5,
      '六': 6,
      '七': 7,
      '八': 8,
      '九': 9
    };

    if (text === '十') {
      return 10;
    }

    if (text.includes('十')) {
      const [tensPart, onesPart] = text.split('十');
      const tens = tensPart ? (digitMap[tensPart] || 0) : 1;
      const ones = onesPart ? (digitMap[onesPart] || 0) : 0;
      const value = tens * 10 + ones;
      return value > 0 ? value : null;
    }

    return digitMap[text] ?? null;
  }

  /**
   * 构建动态时间标签
   * 
   * @param {number} value - 数值
   * @param {string} unit - 单位（hour或day）
   * @param {string} mode - 模式（recent或past）
   * @returns {string} - 时间标签
   */
  static buildDynamicTimeLabel(value, unit, mode = 'recent') {
    const numericValue = Number(value);
    if (!(Number.isFinite(numericValue) && numericValue > 0)) {
      return '';
    }

    const prefix = mode === 'past' ? '过去' : '最近';
    const normalizedUnit = String(unit || '').trim().toLowerCase();
    const unitLabel = normalizedUnit === 'day' ? '天' : '小时';
    return `${prefix}${numericValue}${unitLabel}`;
  }

  /**
   * 规范化动态时间范围
   * 
   * @param {object|string} input - 时间范围对象或字符串
   * @returns {object|null} - 规范化后的时间范围对象或null
   */
  static normalizeDynamicTimeRange(input) {
    if (!input) {
      return null;
    }

    if (typeof input === 'object') {
      const start = Number(input.start);
      const end = Number(input.end);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        const value = Number(input.value);
        return {
          dynamic: true,
          mode: String(input.mode || 'recent').trim() || 'recent',
          unit: String(input.unit || '').trim() || null,
          value: Number.isFinite(value) && value > 0 ? value : null,
          label: String(input.label || '').trim() || '',
          start: this.floorToMinute(start),
          end: this.floorToMinute(end)
        };
      }
    }

    const raw = String(input || '').trim();
    if (!raw) {
      return null;
    }

    const match = raw.match(/(最近|过去|近)\s*([0-9]+|[零一二两三四五六七八九十]{1,3})\s*(?:个)?\s*(小时|天|日)/);
    if (!match) {
      return null;
    }

    const mode = match[1] === '过去' ? 'past' : 'recent';
    const value = /^\d+$/.test(match[2]) ? Number(match[2]) : this.parseChineseNumber(match[2]);
    if (!(Number.isFinite(value) && value > 0)) {
      return null;
    }

    const unit = match[3] === '小时' ? 'hour' : 'day';
    const seconds = unit === 'day' ? value * 24 * 3600 : value * 3600;
    const range = this.getRelativeRange(seconds);
    return {
      dynamic: true,
      mode,
      unit,
      value,
      label: this.buildDynamicTimeLabel(value, unit, mode),
      start: range.start,
      end: range.end
    };
  }

  /**
   * 解析时间范围
   * 
   * 支持多种时间范围格式：对象、动态时间字符串、命名时间范围
   * 
   * @param {object|string} timeRange - 时间范围对象或字符串
   * @returns {object} - 时间范围对象 {start, end}
   */
  static parseTimeRange(timeRange) {
    if (timeRange && typeof timeRange === 'object') {
      const dynamicRange = this.normalizeDynamicTimeRange(timeRange);
      if (dynamicRange?.start && dynamicRange?.end) {
        return {
          start: dynamicRange.start,
          end: dynamicRange.end
        };
      }
    }

    const dynamicFromText = this.normalizeDynamicTimeRange(timeRange);
    if (dynamicFromText?.start && dynamicFromText?.end) {
      return {
        start: dynamicFromText.start,
        end: dynamicFromText.end
      };
    }

    switch (String(timeRange || '').toLowerCase()) {
      case 'yesterday':
      case '昨天':
        return {
          start: this.getYesterdayStart(),
          end: this.getYesterdayEnd()
        };
      case 'today':
      case '今天':
        return {
          start: this.getTodayStart(),
          end: this.getTodayEnd()
        };
      case 'last7days':
      case '最近7天':
        return this.getRelativeRange(7 * 24 * 3600);
      case 'last30days':
      case '最近30天':
        return this.getRelativeRange(30 * 24 * 3600);
      case 'last1hour':
      case '最近1小时':
        return this.getRelativeRange(3600);
      case 'last24hours':
      case '最近一天':
      case '最近24小时':
        return this.getRelativeRange(24 * 3600);
      default:
        logger.warn('Unknown time range:', timeRange);
        return {
          start: this.getYesterdayStart(),
          end: this.getYesterdayEnd()
        };
    }
  }
}

module.exports = TimeUtils;

/**
 * CsvParser.js
 * 
 * CSV 解析工具类
 * 
 * 提供 CSV 文本的解析功能，支持异步和同步两种解析方式。
 * 
 * 修改日期：2026-04-16
 */
const csv = require('csv-parser');
const { Readable } = require('stream');

/**
 * CsvParser 类
 * CSV 解析工具类，提供静态方法解析 CSV 文本
 */
class CsvParser {
  /**
   * 异步解析 CSV 文本
   * 
   * @param {string} csvText - CSV 文本内容
   * @returns {Promise<array>} - 解析后的对象数组
   */
  static parse(csvText) {
    return new Promise((resolve, reject) => {
      const results = [];
      
      const stream = Readable.from([csvText]);
      
      stream
        .pipe(csv())
        .on('data', (row) => {
          results.push(row);
        })
        .on('end', () => {
          logger.info(`CSV parsing completed`, {
            totalRows: results.length
          });
          resolve(results);
        })
        .on('error', (error) => {
          logger.error('CSV parsing failed', { error: error.message });
          reject(error);
        });
    });
  }

  /**
   * 同步解析 CSV 文本
   * 
   * @param {string} csvText - CSV 文本内容
   * @returns {array} - 解析后的对象数组
   */
  static parseSync(csvText) {
    const lines = csvText.trim().split('\n');
    if (lines.length < 2) {
      return [];
    }

    const headers = this.parseCsvLine(lines[0]);
    const results = [];

    for (let i = 1; i < lines.length; i++) {
      const values = this.parseCsvLine(lines[i]);
      const row = {};
      
      headers.forEach((header, index) => {
        row[header] = values[index] || '';
      });
      
      results.push(row);
    }

    logger.info(`CSV sync parsing completed`, {
      totalRows: results.length
    });

    return results;
  }

  /**
   * 解析单行 CSV
   * 
   * 支持带引号的字段，处理逗号在引号内的情况
   * 
   * @param {string} line - CSV 单行文本
   * @returns {array} - 字段值数组
   */
  static parseCsvLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    
    result.push(current.trim());
    return result;
  }

  /**
   * 将 CSV 转换为 JSON
   * 
   * @param {string} csvText - CSV 文本内容
   * @returns {array} - 解析后的对象数组
   */
  static toJson(csvText) {
    return this.parseSync(csvText);
  }
}

const logger = require('../utils/logger');

module.exports = CsvParser;

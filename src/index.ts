/* eslint-disable global-require */
/* eslint-disable import/no-dynamic-require */
import http from 'http';
import https from 'https';
import fetch from 'node-fetch';
import type { OpenAPIObject, OperationObject, SchemaObject } from 'openapi3-ts';
import converter from 'swagger2openapi';
// import converter from './swagger2openapi';
import Log from './log';
import { mockGenerator } from './mockGenerator';
import { ServiceGenerator } from './serviceGenerator';
import type { APIDataType } from './serviceGenerator';

const getImportStatement = (requestLibPath: string) => {
  if (requestLibPath && requestLibPath.startsWith('import')) {
    return requestLibPath;
  }
  if (requestLibPath) {
    return `import request from '${requestLibPath}'`;
  }
  return `import { request } from "umi"`;
};

/**
 * swagger 中 definitions 名称包含 `/` 时，JSON Pointer 无法直接解析。
 * 在转换前统一重命名为安全的 key，并同步修正所有 $ref。
 */
const sanitizeSwaggerDefinitions = (swagger: any) => {
  if (!swagger || typeof swagger !== 'object' || !swagger.definitions) {
    return swagger;
  }

  const definitions = swagger.definitions;
  const renameMap = new Map<string, string>();
  const usedNames = new Set(Object.keys(definitions));

  const ensureUnique = (name: string) => {
    let candidate = name;
    let idx = 1;
    while (usedNames.has(candidate)) {
      candidate = `${name}_${idx}`;
      idx += 1;
    }
    usedNames.add(candidate);
    return candidate;
  };

  Object.keys(definitions).forEach((rawName) => {
    if (!rawName.includes('/')) {
      return;
    }
    const sanitizedBase = rawName.replace(/[\\/]/g, '_');
    const safeName = ensureUnique(sanitizedBase);
    definitions[safeName] = definitions[rawName];
    delete definitions[rawName];
    renameMap.set(rawName, safeName);
  });

  if (!renameMap.size) {
    return swagger;
  }

  const normalizePointer = (key: string) => key.replace(/~1/g, '/').replace(/~0/g, '~');

  const replaceRef = (node: any): void => {
    if (!node || typeof node !== 'object') {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(replaceRef);
      return;
    }
    if (typeof node.$ref === 'string') {
      const match = node.$ref.match(/^#\/definitions\/(.+)$/);
      if (match) {
        const refKey = normalizePointer(match[1]);
        const newName = renameMap.get(refKey);
        if (newName) {
          node.$ref = `#/definitions/${newName}`;
        }
      }
    }
    Object.values(node).forEach(replaceRef);
  };

  replaceRef(swagger);
  return swagger;
};

export type GenerateServiceProps = {
  requestLibPath?: string;
  requestOptionsType?: string;
  requestImportStatement?: string;
  // interface 类型声明方式, 满足某些团队的开发规范
  declareType?: 'type' | 'interface';
  /**
   * api 的前缀
   */
  apiPrefix?:
    | string
    | ((params: {
        path: string;
        method: string;
        namespace: string;
        functionName: string;
        autoExclude?: boolean;
      }) => string);
  /**
   * 生成的文件夹的路径
   */
  serversPath?: string;
  /**
   * Swagger 2.0 或 OpenAPI 3.0 的地址
   */
  schemaPath?: string;
  /**
   * 项目名称
   */
  projectName?: string;
  /**
   * 文档登录凭证
   */
  authorization?: string;

  hook?: {
    /** change open api data after constructor */
    afterOpenApiDataInited?: (openAPIData: OpenAPIObject) => OpenAPIObject;

    /** 自定义函数名称 */
    customFunctionName?: (data: APIDataType) => string;
    /** 自定义类型名称 */
    customTypeName?: (data: APIDataType) => string;
    /** 自定义 options 默认值 */
    customOptionsDefaultValue?: (data: OperationObject) => Record<string, any> | undefined;
    /** 自定义类名 */
    customClassName?: (tagName: string) => string;

    /**
     * 自定义获取type hook
     * 返回非字符串将使用默认方法获取type
     * @example set number to string
     * function customType(schemaObject,namespace){
     *  if(schemaObject.type==='number' && !schemaObject.format){
     *    return 'BigDecimalString';
     *  }
     * }
     */
    customType?: (
      schemaObject: SchemaObject | undefined,
      namespace: string,
      originGetType: (schemaObject: SchemaObject | undefined, namespace: string) => string,
    ) => string;

    /**
     * 自定义生成文件名，可返回多个，表示生成多个文件
     * 返回为空，则使用默认的获取方法获取
     * @example  使用operationId生成文件名
     * function customFileNames(operationObject,apiPath){
     *   const operationId=operationObject.operationId;
     *   if (!operationId) {
     *      console.warn('[Warning] no operationId', apiPath);
     *      return;
     *    }
     *    const res = operationId.split('_');
     *    if (res.length > 1) {
     *      res.shift();
     *      if (res.length > 2) {
     *        console.warn('[Warning]  operationId has more than 2 part', apiPath);
     *      }
     *      return [res.join('_')];
     *    } else {
     *      const controllerName = (res || [])[0];
     *      if (controllerName) {
     *        return [controllerName];
     *      }
     *      return;
     *    }
     * }
     */
    customFileNames?: (
      operationObject: OperationObject,
      apiPath: string,
      _apiMethod: string,
    ) => string[];
  };
  namespace?: string;

  /**
   * 默认为false，true时使用null代替可选
   */
  nullable?: boolean;

  mockFolder?: string;
  /**
   * 模板文件的文件路径
   */
  templatesFolder?: string;

  /**
   * 枚举样式
   */
  enumStyle?: 'string-literal' | 'enum';

  /**
   * response中数据字段
   * example: ['result', 'res']
   */
  dataFields?: string[];

  /**
   * 模板文件、请求函数采用小驼峰命名
   */
  isCamelCase?: boolean;
  /**
   * mock配置
   */
  mockConfig?: {
    /**
     * msw类型mock文件格式.  直接返回对象
     * 举例:
     *  // @ts-ignore

        export default {
          'DELETE /mydata/delete': { message: { message: 'Mydata successfully deleted' } },
        };


        原文件:
        // @ts-ignore
        import { Request, Response } from 'express';

        export default {
          'DELETE /mydata/delete': (req: Request, res: Response) => {
            res.status(200).send({ message: { message: 'Mydata successfully deleted' } });
          },
        };
     */
    msw?: boolean;
  };
  /**切割类型声明文件,默认为false*/
  splitDeclare?: boolean;
};

const converterSwaggerToOpenApi = (swagger: any) => {
  if (!swagger.swagger) {
    return swagger;
  }
  // swagger2openapi 对包含 `/` 的 definition 名称无法解析，先行规范化
  const normalizedSwagger = sanitizeSwaggerDefinitions(JSON.parse(JSON.stringify(swagger)));
  return new Promise((resolve, reject) => {
    converter.convertObj(normalizedSwagger, {}, (err, options) => {
      Log(['💺 将 Swagger 转化为 openAPI']);
      if (err) {
        reject(err);
        return;
      }
      resolve(options.openapi);
    });
  });
};

export const getSchema = async (schemaPath: string, authorization?: string) => {
  if (schemaPath.startsWith('http')) {
    const protocol = schemaPath.startsWith('https:') ? https : http;
    try {
      const agent = new protocol.Agent({
        rejectUnauthorized: false,
      });
      const headers = authorization
        ? {
            authorization,
          }
        : {};
      const json = await fetch(schemaPath, {
        agent,
        headers: authorization ? headers : {},
      }).then((rest) => rest.json());
      return json;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.log('fetch openapi error:', error);
    }
    return null;
  }
  if (require.cache[schemaPath]) {
    delete require.cache[schemaPath];
  }
  const schema = require(schemaPath);
  return schema;
};

const getOpenAPIConfig = async (schemaPath: string, authorization?: string) => {
  const schema = await getSchema(schemaPath, authorization);
  if (!schema) {
    return null;
  }
  const openAPI = await converterSwaggerToOpenApi(schema);
  return openAPI;
};

// 从 appName 生成 service 数据
export const generateService = async ({
  authorization,
  requestLibPath,
  schemaPath,
  mockFolder,
  nullable = false,
  requestOptionsType = '{[key: string]: any}',
  ...rest
}: GenerateServiceProps) => {
  const openAPI = await getOpenAPIConfig(schemaPath, authorization);
  const requestImportStatement = getImportStatement(requestLibPath);
  const serviceGenerator = new ServiceGenerator(
    {
      namespace: 'API',
      requestOptionsType,
      requestImportStatement,
      enumStyle: 'string-literal',
      nullable,
      isCamelCase: true,
      mockConfig: {},
      ...rest,
    },
    openAPI,
  );
  serviceGenerator.genFile();

  if (mockFolder) {
    await mockGenerator({
      openAPI,
      mockFolder: mockFolder || './mocks/',
      mockConfig: rest.mockConfig || {},
    });
  }
};

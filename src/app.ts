// Copyright © 2022 Kaleido, Inc.
//
// SPDX-License-Identifier: Apache-2.0
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import express from 'express';
import http from 'http';
import https from 'https';
import path from 'path';
import swaggerUi from 'swagger-ui-express';
import WebSocket from 'ws';
import YAML from 'yamljs';
import * as eventsHandler from './handlers/events';
import { genTLSContext, init as initCert, loadPeerCAs } from './lib/cert';
import { config, init as initConfig } from './lib/config';
import { IAckEvent } from './lib/interfaces';
// import { Logger } from './lib/logger';
import { Logger } from './lib/winston'
import RequestError, { errorHandler } from './lib/request-error';
import * as utils from './lib/utils';
import { router as apiRouter, setRefreshCACerts } from './routers/api';
import { router as p2pRouter } from './routers/p2p';
import { init as initEvents } from './handlers/events';
import morgan from 'morgan';


const log = new Logger('app');

const swaggerDocument = YAML.load(path.join(__dirname, './swagger.yaml'));

let p2pServer : https.Server
let apiServer : http.Server
let wss : WebSocket.Server

let delegatedWebSocket: WebSocket | undefined = undefined;

export const refreshCACerts = async () => {
  await loadPeerCAs()
  p2pServer.setSecureContext(genTLSContext())
};
setRefreshCACerts(refreshCACerts)

export const start = async () => {
  await initConfig();
  await initCert();
  await initEvents(config);

  const apiApp = express();
  apiServer = http.createServer(apiApp);

  const p2pApp = express();
  p2pServer = https.createServer(genTLSContext(), p2pApp);

  wss = new WebSocket.Server({
    server: apiServer, verifyClient: (info, cb) => {
      if (config.api === undefined || info.req.headers['x-api-key'] === config.apiKey) {
        cb(true);
      } else {
        cb(false, 401, 'Unauthorized');
      }
    }
  });

  eventsHandler.getEmitter().addListener('event', event => {
    log.info(`Event emitted ${event.type}/${event.id}`)
    if (delegatedWebSocket !== undefined) {
      delegatedWebSocket.send(JSON.stringify(event));
    }
  });

  const assignWebSocketDelegate = (webSocket: WebSocket) => {
    log.info('New WebSocket delegate assigned');
    delegatedWebSocket = webSocket;
    webSocket.on('message', async message => {
      try {
        const messageContent = JSON.parse(message.toLocaleString());
        if (messageContent.action === 'ack' || messageContent.action == 'commit') {
          eventsHandler.handleAck(messageContent as IAckEvent);
        }
      } catch (err) {
        log.error(`Failed to process websocket message ${err}`);
      }
    });
    webSocket.on('close', () => {
      log.info('WebSocket delegate disconnected');
      const nextDelegatedWebSocket = wss.clients.values().next().value;
      if (nextDelegatedWebSocket) {
        assignWebSocketDelegate(nextDelegatedWebSocket);
      } else {
        delegatedWebSocket = undefined;
      }
    });
    // Anything that's in-flight needs to be sent again
    eventsHandler.reDispatchInFlight();
  };

  wss.on('connection', (webSocket: WebSocket) => {
    log.info(`New WebSocket client connected (client count: ${wss.clients.size})`);
    if (delegatedWebSocket === undefined) {
      assignWebSocketDelegate(webSocket);
    }
    webSocket.on('close', () => {
      log.info(`WebSocket client disconnected (client count: ${wss.clients.size})`);
    });
  });

  apiApp.use('/swagger', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

  apiApp.use((req, res, next) => {
    if (req.path === '/') {
      res.redirect('/swagger');
    } else {
      if (config.apiKey !== undefined && req.headers['x-api-key'] !== config.apiKey) {
        next(new RequestError('Unauthorized', 401));
      } else {
        next();
      }
    }
  });

  log.info(path.join(__dirname, 'access.log'));
  apiApp.use(morgan('--> :method :url', { 
    stream: { write: (message) => log.info(message) }
  }));
  apiApp.use(morgan('<-- :method :url [:status] :res[content-length] - :response-time ms', { 
    stream: { write: (message) => log.info(message) }
  }));
  apiApp.use(express.urlencoded({ extended: true }));
  apiApp.use(express.json({limit: config.jsonParserLimit ?? utils.constants.DEFAULT_JSON_PARSER_LIMIT}));
  apiApp.use('/api/v1', apiRouter);
  apiApp.use(errorHandler);

  p2pApp.use(morgan('[:date[iso]] --> :method :url', { 
    stream: { write: (message) => log.info(message) }
  }));
  p2pApp.use(morgan('[:date[iso]] <-- :method :url [:status] :res[content-length] - :response-time ms', { 
    stream: { write: (message) => log.info(message) }
  }));
  p2pApp.use('/api/v1', p2pRouter);
  p2pApp.use(errorHandler);

  const apiServerPromise = new Promise<void>(resolve => apiServer.listen(config.api.port, config.api.hostname, () => resolve()));
  const p2pServerPromise = new Promise<void>(resolve => p2pServer.listen(config.p2p.port, config.p2p.hostname, () => resolve()));
  await Promise.all([apiServerPromise, p2pServerPromise]);
  log.info(`FireFly Data Exchange running on http://${config.api.hostname}:${config.api.port} (API) and ` +
    `https://${config.p2p.hostname}:${config.p2p.port} (P2P) - log level "${utils.constants.LOG_LEVEL}"`);

};

const shutdownHandler = (resolve : (value: void | PromiseLike<void>) => void) => {
  return (err: Error | undefined) => {
    if (err === undefined) {
      resolve();
    } else {
      log.error(`Failed to close server due to ${err}`);
    }
  };
};

export const stop = async () => {
  // add any additional logic for ensuring clients and handlers are finished with their work before shutting down
  log.info("FireFly Data Exchange is gracefully shutting down the webservers");
  const apiServerPromise = new Promise<void>(resolve => apiServer.close( shutdownHandler(resolve)));
  const p2pServerPromise = new Promise<void>(resolve => p2pServer.close( shutdownHandler(resolve)));
  const wssPromise = new Promise<void>(resolve => wss.close(shutdownHandler(resolve)));
  await Promise.all([apiServerPromise, p2pServerPromise, wssPromise]);
  log.info("FireFly Data Exchange has stopped all webservers, exiting");
  process.exit();
};

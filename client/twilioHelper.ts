"use strict";

import { Client as TwilioChatClient } from "twilio-chat";
import axios from "axios";
import RNFS from "react-native-fs";
import config from "../config";
import { store } from "../store/store";
import * as actions from "../store/chat/chat.actions";
import { getMessagesForRoomSid, saveMessage } from "./db";
import { IMessage } from "react-native-gifted-chat";

interface MessageType extends IMessage {
	index: number;
}

export default class ChatClientHelper {
	private authToken: string;
	private chatClient: TwilioChatClient | null;
	private chatRoomClients: any;
	public sendMessage: (sid: any, message: any) => void;
	public setAllMessagesConsumed: (sid: any, messageId: any) => void;
	public getSingleMessage: (sid: any, messageId: number) => void;

	constructor(authToken: string) {
		this.authToken = authToken;
		this.chatClient = null;
		this.chatRoomClients = {};

		this.sendMessage = this._sendMessage.bind(this);
		this.setAllMessagesConsumed = this._setAllMessagesConsumed.bind(this);
		this.getSingleMessage = this._getSingleMessage.bind(this);
	}

	getToken() {
		return axios
			.get(`${config.apiUrl}/chat/token`, {
				headers: { Authorization: this.authToken },
			})
			.then((res) => {
				return res.data.twilioToken;
			})
			.catch((err) => {
				return;
			});
	}

	login() {
		return this.getToken()
			.then((twilioToken) => {
				return TwilioChatClient.create(twilioToken);
			})
			.then((chatClient) => {
				this.chatClient = chatClient;
				store.dispatch(
					actions.addTwilioCurrentUser(this.chatClient?.user.identity)
				);
				return this.subscribeToAllChatClientEvents();
			})
			.catch(() => {
				// TODO - Check for internet access
			});
	}

	subscribeToAllChatClientEvents() {
		this.chatClient?.on("tokenAboutToExpire", () => {
			this.getToken()
				.then((newToken) => this.chatClient?.updateToken(newToken))
				.catch((err) => {
					return;
				});
		});

		// TODO - Check for new messages
		this.chatClient?.on("tokenExpired", () => {
			this.getToken()
				.then((newToken) => this.chatClient?.updateToken(newToken))
				.then(() => {
					// TODO - Possibly need to check for missed messages
				})
				.catch((err) => {
					return;
				});
		});

		this.chatClient?.on("channelJoined", async (obj) => {
			// Get any messages from DB
			const existingMessages: any = await getMessagesForRoomSid(obj.sid);
			const len = existingMessages.rows.length;
			const lastSavedMessageIndex =
				existingMessages.rows.item(0) &&
				existingMessages.rows.item(0).messageIndex;
			const lastRoomMessageIndex = obj?.lastMessage?.index ?? 0;
			const messages: MessageType[] = [];

			for (let i = 0; i < len; i++) {
				const {
					sid,
					messageIndex,
					body,
					timestamp,
					author,
					imageName,
					meta,
				} = existingMessages.rows.item(i);
				const { friendlyName } = JSON.parse(meta);
				messages.push({
					_id: sid,
					index: messageIndex,
					text: body,
					createdAt: new Date(timestamp),
					user: {
						_id: String(author),
						name: String(friendlyName ? friendlyName : author),
					},
					// @ts-ignore
					image: !imageName
						? null
						: `file://${RNFS.DocumentDirectoryPath}/${imageName}`,
				});
			}

			// Add room to array of clients and redux store
			const room = {
				sid: obj.sid,
				name: obj.friendlyName,
				attributes: obj.attributes,
				lastConsumedMessageIndex: obj.lastConsumedMessageIndex,
				messages,
			};
			store.dispatch(actions.addTwilioChatRoom(room));
			this.chatRoomClients[obj.sid] = obj;

			// Get any new messages
			const messagesToGet = !len
				? 100
				: lastRoomMessageIndex - lastSavedMessageIndex;
			let promises: any[] = [];
			if (messagesToGet > 0) {
				const messagesPaginator = await obj.getMessages(messagesToGet);
				messagesPaginator.items.forEach((message: any) => {
					promises.push(this.messageRecieved(message));
				});
			}
			await Promise.all(promises);

			// Increase no of rooms loaded
			store.dispatch(actions.increaseTwilioChatRoomsLoaded(1));
		});

		this.chatClient?.on("channelLeft", (obj) => {
			store.dispatch(actions.removeTwilioChatRoom(obj.sid));
		});

		this.chatClient?.on("messageAdded", (message) => {
			this.messageRecieved(message);
		});
	}

	async messageRecieved(messageObj: any) {
		const isMedia = messageObj.type === "media";
		const imageName = isMedia ? await this._getImageName(messageObj) : null;
		const url = isMedia ? await messageObj.media.getContentUrl() : null;
		const savePromise = saveMessage(messageObj, imageName);
		const downloadPromise = this._downloadImage(imageName!, url);

		try {
			await Promise.all([savePromise, downloadPromise]);
			const incomingMessage: MessageType = {
				_id: messageObj.sid,
				index: messageObj.index,
				text: messageObj.body,
				createdAt: new Date(messageObj.timestamp),
				user: {
					_id: messageObj.author,
					name:
						messageObj.attributes?.friendlyName ??
						messageObj?.author,
				},
				// @ts-ignore
				image: !imageName
					? null
					: `file://${RNFS.DocumentDirectoryPath}/${imageName}`,
			};
			return store.dispatch(
				actions.addTwilioMessageToChatRoom({
					incomingMessage,
					roomId: messageObj.channel.sid,
				})
			);
		} catch (err) {
			// Don't need to handle as this is when duplicate message is trying to save to DB (err code 6)
		}
	}

	_sendMessage(sid: any, message: any) {
		return this.chatRoomClients[sid].sendMessage(message, {
			friendlyName: this.chatClient?.user.friendlyName,
		});
	}

	_setAllMessagesConsumed(sid: any, messageId: any) {
		if (
			!sid ||
			!messageId ||
			!this.chatRoomClients ||
			!this.chatRoomClients[sid] ||
			!this.chatRoomClients[sid].setAllMessagesConsumed
		) {
			return;
		}
		return this.chatRoomClients[sid]
			.setAllMessagesConsumed()
			.then(() => {
				store.dispatch(
					actions.updateMessagesConsumedIndex({ sid, messageId })
				);
				return;
			})
			.catch((err: any) => err);
	}

	async _getImageName(messageObj: any) {
		const filename = await messageObj.media.contentType;
		const extension = filename.split("/")[1];
		return `${messageObj.sid}.${extension}`;
	}

	_downloadImage(imageName: string, url: string) {
		if (!imageName || !url) {
			return;
		}
		const promise = RNFS.downloadFile({
			fromUrl: url,
			toFile: `${RNFS.DocumentDirectoryPath}/${imageName}`,
		}).promise;
		return promise;
	}

	async _getSingleMessage(sid: any, messageId: number) {
		const messagesPaginator = await this.chatRoomClients[sid].getMessages(
			1,
			messageId,
			"forward"
		);
		if (!messagesPaginator.items.length) return;

		messagesPaginator.items.forEach((message: any) => {
			this.messageRecieved(message);
		});

		return;
	}
}

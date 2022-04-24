import type { NextApiRequest, NextApiResponse } from "next";
import { User } from "models/user.types";
import { authHandler } from "utils/apiAuthHandler";
const AccessToken = require("twilio").jwt.AccessToken;
const ChatGrant = AccessToken.ChatGrant;

type Data = {
	identity: any;
	twilioToken: string;
};

type Error = {
	error: any;
};

function handler(
	req: NextApiRequest,
	res: NextApiResponse<Data | Error>,
	user: User
) {
	switch (req.method) {
		case "GET":
			get();
			break;
		default:
			res.setHeader("Allow", ["GET"]);
			res.status(405).end(`Method ${req.method} Not Allowed`);
	}

	function get() {
		try {
			const chatGrant = new ChatGrant({
				serviceSid: process.env.TWILIO_SERVICE_INSTANCE_SID,
			});

			const twilioToken = new AccessToken(
				process.env.TWILIO_ACCOUNT_SID,
				process.env.TWILIO_API_KEY,
				process.env.TWILIO_API_SECRET
			);

			twilioToken.addGrant(chatGrant);
			twilioToken.identity = String(user.id);
			twilioToken.ttl = 86400;
			res.status(200).json({
				identity: twilioToken.identity,
				twilioToken: twilioToken.toJwt(),
			});
		} catch (error) {
			res.status(500).json({ error });
		}
	}
}

export default authHandler(handler, "general");

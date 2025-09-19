import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as JSONStream from 'JSONStream';
import * as https from 'https';
import * as os from 'os';
import { send } from 'process';
import { LOADIPHLPAPI } from 'dns';
import { serialize } from 'v8';
import * as web from './web';
import { exec } from 'child_process';
import { glob } from 'glob';
import { privateEncrypt } from 'crypto';

const axios = require('axios');
const { createHash } = require('crypto');

export class LogNameMannager {
	private static readonly staticInfoFile: string = "staticInfo.txt";
	private static readonly dynamicInfoFile: string = "dynamicInfo.txt";
	private static staticFileStore: fs.PathLike;
	private static dynamicFileStore: fs.PathLike;
	public static machineId: string;
	private static cannotSaveStatic: boolean = false;
	private static cannotSaveDynamic: boolean = false;
	private static cannotReadName: boolean = false;
	public static courseID: string;
	public static assignmentID: string;
	public static logSessionID: string = "1";
	public static username: string = "User";


	public static hash(string) {
		return createHash('sha256').update(string).digest('hex');
	}

	public static getHashedHardwareAddress(): string {
		const networkInterfaces = os.networkInterfaces();
	  
		// Iterate over network interfaces to find the MAC address
		for (const [, interfaces] of Object.entries(networkInterfaces)) {
		  // console.log(interfaces);
		  for (const iface of interfaces) {
			// Check if the interface is not a loopback and is not a virtual interface
			if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
			  return this.hash(iface.mac);
			}
		  }
		}
	  
		// Return an empty string if the machine ID could not be found
		return '';
	}
	  
	private static maybeInitializeFileStore() : void {
		if (this.staticFileStore !== null && this.dynamicFileStore !== null) {
			return;
		}
		this.initializeFileStore();
//		File searchLoc = new File(System.getProperty("user.home") + "/helper-config/");
//		if (searchLoc.exists())
//			fileStore = new File(System.getProperty("user.home") + "/helper-config/" + uuidFile);
//		else
//			fileStore = new File(uuidFile);
	}

	public static initializeFileStore(): void {
		let temp = vscode.workspace.workspaceFolders[0].uri.path + "VSCODE-config";
		let localDir = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath || '', 'VSCODE-config');
		let globalDir = path.join(os.homedir() || '', "VSCODE-config");
		console.log(localDir);
		let ioLog = path.join(localDir, "IO-Log");
		if(!fs.existsSync(localDir)){
			try{
				fs.mkdirSync(localDir, {recursive : true});
				console.log("localDir created successful");
			}catch(err){
				console.log("line634" + err);
			}
		}
		if(!fs.existsSync(globalDir)){
			try{
				fs.mkdirSync(globalDir, {recursive : true});
				console.log("globalDir created successful");
			}catch(err){
				console.log("line642" + err);
			}
		}
		if(!fs.existsSync(ioLog)){
			try{
				fs.mkdirSync(ioLog, {recursive: true});
				console.log("IO log dir created successful");
			}catch(err){
				console.log("line680" + err);
			}
		}
		this.staticFileStore = path.join(globalDir, this.staticInfoFile);
		this.dynamicFileStore = path.join(localDir, this.dynamicInfoFile);
		try{
			fs.appendFileSync(this.staticFileStore, '');
			fs.appendFileSync(this.dynamicFileStore, '');
			fs.chmodSync(this.staticFileStore, 0o777);
			fs.chmodSync(this.dynamicFileStore, 0o777);
			console.log("Info files created successful");
		}catch(err){
			console.log("line654" + err);
		}
	}

	public static getRandomID(): string {
		const aRandomDouble: number = Math.random();
		const aRandomInteger: number = Math.round(aRandomDouble * 1000);
		return aRandomInteger.toString();
	}

	public static saveStaticInfo(): void{
		if (this.cannotSaveStatic) {
		  return;
		}
		try {
		  if (!fs.existsSync(this.staticFileStore)) {
			fs.writeFileSync(this.staticFileStore, '');
		  }
		  fs.chmodSync(this.staticFileStore, 0o777);
		  fs.writeFileSync(this.staticFileStore, "\"This is the static info file. Info: MachineID, username\"" + "\n");
		  fs.appendFileSync(this.staticFileStore, this.machineId + "\n");
		  fs.appendFileSync(this.staticFileStore, this.username + "\n");
		  console.log("Static Info saved!");
		} catch (e) {
		  console.error("Cannot save file: " + e.message);
		  this.cannotSaveStatic = true;
		}
	}

	public static setStaticInfo(){
		this.machineId = this.getHashedHardwareAddress();
		this.username = this.username += this.getRandomID();
	}

	public static getStaticInfo(){
		this.maybeInitializeFileStore();
	  
		if (!fs.existsSync(this.staticFileStore)) {
		  return null;
		}
		try {
		  const data = fs.readFileSync(this.staticFileStore, 'utf8');
		  const lines = data.split('\n');
		  if(lines.length >= 3){
			return [lines[1], lines[2]];
		  }
		  return null;
		} catch (e) {
		  console.log("line702" + e);
		  return null;
		}
	}

	public static updateLogSessionID(): void {
		let info = this.getStaticInfo();
		this.machineId = info[0];
		this.courseID = info[1];
		this.assignmentID = info[2];
		this.logSessionID = info[3];
		this.logSessionID += 1;
		this.saveStaticInfo();
	}

	private static getCourseAndAssignment(){
		let path = vscode.workspace.workspaceFolders[0]['uri']['path'];
		let parts = path.toString().split('/');
		let course = parts[parts.length - 2];
		let assignment = parts[parts.length - 1];
		return [course, assignment];
	}

	public static updateUsername(message){
		this.username = message['username'] + this.getRandomID();
		this.saveStaticInfo();
	}

	public static saveDynamicInfo(): void{
		if (this.cannotSaveDynamic) {
		  return;
		}
		try {
		  if (!fs.existsSync(this.dynamicFileStore)) {
			fs.writeFileSync(this.dynamicFileStore, '');
		  }
		  fs.chmodSync(this.dynamicFileStore, 0o777);
		  fs.writeFileSync(this.dynamicFileStore, "\"This is the dynamic info file. Info: CourseID, AssignmentID, LogSessionID\"" + "\n");
		  fs.appendFileSync(this.dynamicFileStore, this.courseID + "\n");
		  fs.appendFileSync(this.dynamicFileStore, this.assignmentID + "\n");
		  fs.appendFileSync(this.dynamicFileStore, this.logSessionID);
		  console.log("Dynamic Info saved!");
		} catch (e) {
		  console.error("Cannot save file: " + e.message);
		  this.cannotSaveDynamic = true;
		}
	}

	public static setDynamicInfo(): void{
		this.courseID = this.getCourseAndAssignment()[0];
		this.assignmentID = this.getCourseAndAssignment()[1];
	}

	public static getDynamicInfo(){
		this.maybeInitializeFileStore();

		if(!fs.existsSync(this.dynamicFileStore)){
			return null;
		}
		try {
			const data = fs.readFileSync(this.dynamicFileStore, 'utf8');
			const lines = data.split('\n');
			if(lines.length >= 3){
				return [lines[1], lines[2], lines[3]];
			}
			return null;
		}catch (e){
			console.log("line769" + e);
			return null;
		}
	}

	public static readUsername(): string{ //TODO rewrite
		this.maybeInitializeFileStore();
	  
		if (!fs.existsSync(this.dynamicFileStore) || this.cannotReadName) {
		  return null;
		}
		try {
		  const data = fs.readFileSync(this.staticFileStore, 'utf8');
		  const lines = data.split('\n');
		  let lastName = lines[2];
		  return lastName;
		} catch (e) {
			console.log("line786" + e);
		  this.cannotReadName = true;
		  return null;
		}
	  }
}